---
outline: deep
---

# LGA Check 模块分析

## 一、模块概述

### 1.1 功能定位
**LGA Check (Land Grid Array Check)** 是华为 MATE X5 硬件监控系统中的 **LGA 主板异常检测模块**，专门用于监测设备主板上 LGA 连接器（陆地网格阵列）的健康状态，通过 ADC 电压采样、GPIO 电平检测、中断触发等多种方式实时监控主板连接是否存在断裂、虚焊、接触不良等异常。

### 1.2 核心功能
- **多模式检测**：支持 ADC（电压检测）、GPIO（电平检测）、IRQ（中断检测）三种检测模式
- **充电场景监控**：在充电启动/停止时触发检测，防止充电时的热应力导致 LGA 失效
- **自动 DMD 上报**：检测到异常时自动上报 DMD（Device Monitor Diagnosis）告警
- **防重复上报**：限制最多上报 5 次，避免日志泛滥
- **Sysfs 查询接口**：提供用户态查询接口，实时获取 LGA 状态

### 1.3 设计背景
LGA（Land Grid Array）是一种无引脚封装技术，广泛用于主板与芯片之间的连接。在折叠屏设备（如 MATE X5）中，频繁的折叠操作、充电时的热膨胀、跌落冲击等都可能导致 LGA 触点接触不良或断裂。该模块通过在关键位置部署检测点，实现对主板健康状态的实时监控。

---

## 二、系统架构

### 2.1 模块组成
```
lga_check 模块
├── lga_check.c         # 主逻辑（检测、上报、事件处理）
├── lga_check.h         # 数据结构定义
├── Kconfig             # 内核配置
└── Makefile            # 编译配置
```

### 2.2 架构分层
```
+---------------------------------------------------------------+
|                    User Space (Sysfs)                         |
|  /sys/class/hw_power/lga_ck/status (只读，实时检测状态)         |
+---------------------------------------------------------------+
                              ↓
+---------------------------------------------------------------+
|                  lga_check.c (检测引擎)                       |
|  - lga_status_check(): 遍历所有检测点                         |
|  - lga_status_check_adc_vol(): ADC 电压检测                   |
|  - lga_status_check_gpio_val(): GPIO 电平检测                 |
|  - lga_status_check_irq_val(): IRQ 中断检测                   |
+---------------------------------------------------------------+
                              ↓
+---------------------------------------------------------------+
|                  Hardware Interface Layer                     |
|  - power_platform_get_adc_voltage(): ADC 读取                 |
|  - gpio_get_value(): GPIO 读取                                |
|  - request_irq(): 中断注册                                     |
+---------------------------------------------------------------+
                              ↓
+---------------------------------------------------------------+
|                  Hardware (LGA Connectors)                    |
|  - LGA 检测点 1 (ADC 分压电路)                                 |
|  - LGA 检测点 2 (GPIO 上拉/下拉)                               |
|  - LGA 检测点 3 (IRQ 触发电路)                                 |
+---------------------------------------------------------------+
```

### 2.3 检测触发机制
```
触发方式 1: 充电事件驱动
   POWER_NE_CHARGING_START → 延迟 30s → lga_ck_detect_work()
   POWER_NE_CHARGING_STOP → 取消检测任务

触发方式 2: 中断驱动（LGA_CK_MODE_IRQ）
   硬件中断触发 → lga_ck_interrupt() → 延迟 30s → lga_ck_detect_work()

触发方式 3: 主动查询（Sysfs）
   用户读取 /sys/class/hw_power/lga_ck/status → 实时执行检测
```

---

## 三、核心数据结构

### 3.1 检测参数结构
```c
struct lga_ck_para_info {
    int type;                   // 检测模式 (ADC/GPIO/IRQ)
    char name[16];              // 检测点名称（如 "lga_check_adc_0"）
    int threshold;              // 异常阈值
    int dmd_no;                 // DMD 上报错误号
    int dmd_switch;             // DMD 上报开关 (0=关闭, 1=开启)
    
    // ADC 模式专用
    u32 adc_no;                 // ADC 通道号
    int adc_vol;                // ADC 电压值（mV）
    
    // GPIO 模式专用
    int gpio_no;                // GPIO 编号
    int gpio_val;               // GPIO 电平值 (0/1)
    
    // IRQ 模式专用
    int irq_gpio_no;            // 中断 GPIO 编号
    int irq_int;                // 中断号
    int irq_val;                // 中断 GPIO 电平值
    
    int status;                 // 检测结果 (0=正常, -1=异常)
};
```

### 3.2 设备管理结构
```c
struct lga_ck_dev {
    struct device *dev;                        // Sysfs 设备节点
    struct notifier_block nb;                  // 充电事件通知器
    struct delayed_work detect_work;           // 延迟检测工作队列
    struct lga_ck_para_data data;              // 检测参数数组
    int abnormal_time;                         // 异常上报次数计数器
};

struct lga_ck_para_data {
    int total_type;                            // 检测点总数（最多 8 个）
    struct lga_ck_para_info para[8];           // 检测点参数数组
};
```

### 3.3 检测模式枚举
```c
enum lga_ck_mode {
    LGA_CK_MODE_ADC,     // ADC 电压检测模式
    LGA_CK_MODE_GPIO,    // GPIO 电平检测模式
    LGA_CK_MODE_IRQ,     // 中断触发检测模式
};
```

---

## 四、核心算法与工作流程

### 4.1 检测工作流程（lga_ck_detect_work）

```c
static void lga_ck_detect_work(struct work_struct *work)
{
    // 1. 检查上报次数限制（最多 5 次）
    if (l_dev->abnormal_time >= LGA_CK_MAX_DMD_REPORT_TIME) {
        hwlog_err("abnormal over 5 time\n");
        return;  // 已上报 5 次，停止检测
    }
    
    // 2. 执行所有检测点的状态检查
    if (lga_status_check(l_dev)) {
        // 3. 发现异常：上报 DMD
        lga_dmd_report(l_dev);
        
        // 4. 增加异常计数器
        l_dev->abnormal_time++;
    }
}
```

**时序图**：
```
充电启动事件
    ↓
取消旧任务 (cancel_delayed_work)
    ↓
调度新任务 (延迟 30s)
    ↓
30 秒后执行 lga_ck_detect_work()
    ↓
遍历所有检测点 (lga_status_check)
    ↓
发现异常？
    ├─ 是 → lga_dmd_report() → abnormal_time++
    └─ 否 → 结束
```

### 4.2 ADC 电压检测算法（lga_status_check_adc_vol）

```c
static int lga_status_check_adc_vol(struct lga_ck_para_info *info)
{
    info->status = LGA_CK_FRACTURE_FREE;  // 默认正常
    
    // 1. 读取 ADC 电压（带重试机制，最多 3 次）
    info->adc_vol = lga_get_adc_vol(info->adc_no);
    
    // 2. 判断电压是否超过阈值
    if (info->adc_vol > info->threshold) {
        hwlog_info("adc_vol is over threshold %d\n", info->threshold);
        info->status = LGA_CK_FRACTURE_FOUND;  // 标记异常
    }
    
    return info->status;
}
```

**检测原理**：
- LGA 连接正常时，分压电路输出电压低于阈值（如 < 500mV）
- LGA 断裂或接触不良时，电路开路，电压上升至高电平（如 > 1500mV）
- 通过 ADC 采样电压判断连接状态

**ADC 读取函数**（带重试）：
```c
static int lga_get_adc_vol(u32 adc_channel)
{
    int i;
    int adc_vol;
    
    for (i = 0; i < LGA_CK_ADC_MAX_RETRYS; i++) {
        adc_vol = power_platform_get_adc_voltage(adc_channel);
        if (adc_vol >= 0)
            break;  // 读取成功
        hwlog_err("adc read fail, retry=%d\n", i + 1);
    }
    
    return adc_vol;
}
```

### 4.3 GPIO 电平检测算法（lga_status_check_gpio_val）

```c
static int lga_status_check_gpio_val(struct lga_ck_para_info *info)
{
    info->status = LGA_CK_FRACTURE_FREE;
    
    // 1. 读取 GPIO 电平
    info->gpio_val = gpio_get_value(info->gpio_no);
    
    // 2. 判断电平是否等于阈值（阈值通常为 1 或 0）
    if (info->gpio_val == info->threshold) {
        hwlog_info("gpio_val is equal threshold %d\n", info->threshold);
        info->status = LGA_CK_FRACTURE_FOUND;
    }
    
    return info->status;
}
```

**检测原理**：
- GPIO 配置为输入模式，带上拉或下拉电阻
- LGA 正常连接时，GPIO 被拉至特定电平（如低电平 0）
- LGA 断裂时，GPIO 悬空被上拉电阻拉高（如高电平 1）
- 通过检测 GPIO 电平变化判断连接状态

### 4.4 中断检测算法（lga_status_check_irq_val）

```c
static int lga_status_check_irq_val(struct lga_ck_para_info *info)
{
    info->status = LGA_CK_FRACTURE_FREE;
    
    // 1. 读取中断 GPIO 的电平值
    info->irq_val = lga_get_gpio_val(info->irq_gpio_no);
    
    // 2. 判断是否等于阈值
    if (info->irq_val == info->threshold) {
        hwlog_info("irq_val is equal threshold %d\n", info->threshold);
        info->status = LGA_CK_FRACTURE_FOUND;
    }
    
    return info->status;
}
```

**中断处理函数**：
```c
static irqreturn_t lga_ck_interrupt(int irq, void *data)
{
    // 1. 取消之前的检测任务
    cancel_delayed_work(&l_dev->detect_work);
    
    // 2. 重新调度延迟 30s 的检测任务
    schedule_delayed_work(&l_dev->detect_work,
        msecs_to_jiffies(LGA_CK_WORK_DELAY_TIME));
    
    return IRQ_HANDLED;
}
```

**检测原理**：
- LGA 连接点配置为下降沿触发中断（IRQF_TRIGGER_FALLING）
- 正常情况下 GPIO 保持稳定电平
- LGA 断裂瞬间产生电平跳变，触发中断
- 中断触发后延迟 30s 执行检测，避免抖动误报

### 4.5 DMD 上报算法（lga_dmd_report）

```c
static void lga_dmd_report(struct lga_ck_dev *l_dev)
{
    char dsm_buff[128] = { 0 };
    
    // 遍历所有检测点
    for (i = 0; i < l_dev->data.total_type; i++) {
        // 1. 检查 DMD 上报开关
        if (l_dev->data.para[i].dmd_switch == 0)
            continue;
        
        // 2. 检查是否发现异常
        if (l_dev->data.para[i].status == LGA_CK_FRACTURE_FREE)
            continue;
        
        // 3. 根据检测模式格式化上报信息
        switch (l_dev->data.para[i].type) {
        case LGA_CK_MODE_ADC:
            snprintf(dsm_buff, 127,
                "lga abnormal: adc_channel=%d, adc_vol=%d[mV]\n",
                l_dev->data.para[i].adc_no,
                l_dev->data.para[i].adc_vol);
            break;
        case LGA_CK_MODE_GPIO:
            snprintf(dsm_buff, 127,
                "lga abnormal: gpio_no=%d, gpio_val=%d\n",
                l_dev->data.para[i].gpio_no,
                l_dev->data.para[i].gpio_val);
            break;
        case LGA_CK_MODE_IRQ:
            snprintf(dsm_buff, 127,
                "lga abnormal: irq_gpio_no=%d, irq_val=%d\n",
                l_dev->data.para[i].irq_gpio_no,
                l_dev->data.para[i].irq_val);
            break;
        }
        
        // 4. 上报 DMD
        power_dsm_report_dmd(POWER_DSM_PMU_OCP,
            l_dev->data.para[i].dmd_no, dsm_buff);
        
        // 5. 延迟 3s 避免上报过快
        msleep(LGA_CK_DMD_DELAY_TIME);
    }
}
```

---

## 五、事件处理机制

### 5.1 充电事件订阅
```c
static int lga_ck_probe(struct platform_device *pdev)
{
    // 订阅充电事件通知
    l_dev->nb.notifier_call = lga_ck_event_call;
    power_event_bnc_register(POWER_BNT_CHARGING, &l_dev->nb);
}
```

### 5.2 充电事件处理
```c
static int lga_ck_event_call(struct notifier_block *nb,
    unsigned long event, void *data)
{
    switch (event) {
    case POWER_NE_CHARGING_STOP:
        // 充电停止：取消检测任务
        cancel_delayed_work(&l_dev->detect_work);
        break;
        
    case POWER_NE_CHARGING_START:
        // 充电启动：先取消旧任务，再调度新任务
        cancel_delayed_work(&l_dev->detect_work);
        schedule_delayed_work(&l_dev->detect_work,
            msecs_to_jiffies(LGA_CK_WORK_DELAY_TIME));
        break;
    }
    
    return NOTIFY_OK;
}
```

**设计意图**：
- 充电时设备会发热，热膨胀可能导致 LGA 连接异常
- 在充电启动 30 秒后检测，等待系统稳定
- 充电停止时取消检测，节省系统资源

---

## 六、DTS 配置说明

### 6.1 配置示例
```dts
lga_check {
    compatible = "huawei,lga_check";
    pinctrl-names = "default", "idle";
    pinctrl-0 = <&lga_check_default>;
    pinctrl-1 = <&lga_check_idle>;
    
    /* 检测参数配置 */
    check_para = <
        /* type, name,            threshold, dmd_no,  dmd_switch */
        "1"    "lga_check_adc_0"   "1500"     "25001"  "1"
        "2"    "lga_check_gpio_1"  "1"        "25002"  "1"
        "3"    "lga_check_irq_2"   "0"        "25003"  "1"
    >;
};
```

### 6.2 参数说明

#### check_para 数组格式
每个检测点需要 5 个参数：

| 序号 | 参数名 | 说明 | 示例 |
|------|--------|------|------|
| 0 | type | 检测模式<br>1=ADC, 2=GPIO, 3=IRQ | "1" (ADC) |
| 1 | name | 检测点名称<br>- ADC: DTS ADC 通道名<br>- GPIO: DTS GPIO 属性名<br>- IRQ: DTS 中断 GPIO 属性名 | "lga_check_adc_0" |
| 2 | threshold | 异常阈值<br>- ADC: 电压阈值（mV）<br>- GPIO: 电平阈值（0/1）<br>- IRQ: 电平阈值（0/1） | "1500" (mV) |
| 3 | dmd_no | DMD 错误码 | "25001" |
| 4 | dmd_switch | DMD 上报开关<br>0=关闭, 1=开启 | "1" (开启) |

#### 完整配置示例
```dts
lga_check {
    compatible = "huawei,lga_check";
    
    /* Pinctrl 配置 */
    pinctrl-names = "default", "idle";
    pinctrl-0 = <&lga_default>;
    pinctrl-1 = <&lga_idle>;
    
    /* ADC 通道定义 */
    lga_check_adc_0 = <5>;  // ADC 通道 5
    lga_check_adc_1 = <6>;  // ADC 通道 6
    
    /* GPIO 定义 */
    lga_check_gpio_1 = <&gpio25 3 0>;  // GPIO 25_3
    lga_check_gpio_2 = <&gpio26 5 0>;  // GPIO 26_5
    
    /* 中断 GPIO 定义 */
    lga_check_irq_2 = <&gpio27 2 0>;   // GPIO 27_2
    
    /* 检测参数配置 */
    check_para = <
        /* ADC 检测点 0: 电压超过 1500mV 为异常 */
        "1"  "lga_check_adc_0"   "1500"  "25001"  "1"
        
        /* ADC 检测点 1: 电压超过 1800mV 为异常 */
        "1"  "lga_check_adc_1"   "1800"  "25002"  "1"
        
        /* GPIO 检测点 1: 电平为 1 时异常 */
        "2"  "lga_check_gpio_1"  "1"     "25003"  "1"
        
        /* GPIO 检测点 2: 电平为 0 时异常 */
        "2"  "lga_check_gpio_2"  "0"     "25004"  "1"
        
        /* IRQ 检测点 2: 中断触发且电平为 1 时异常 */
        "3"  "lga_check_irq_2"   "1"     "25005"  "1"
    >;
};
```

### 6.3 工厂模式特殊处理
```c
// 在工厂模式下，GPIO 不执行 request_gpio 操作
// 因为工厂夹具检测可能会复用同一个 GPIO
if (power_cmdline_is_factory_mode()) {
    info->gpio_no = of_get_named_gpio(np, string, 0);
    return 0;  // 仅获取 GPIO 编号，不申请资源
}
```

---

## 七、Sysfs 接口

### 7.1 节点路径
```bash
/sys/class/hw_power/lga_ck/status
```

### 7.2 接口说明
```c
static ssize_t lga_ck_sysfs_show(struct device *dev,
    struct device_attribute *attr, char *buf)
{
    switch (info->name) {
    case LGA_CK_SYSFS_STATUS:
        // 执行实时检测并返回结果
        return scnprintf(buf, PAGE_SIZE, "%d\n",
            lga_status_check(l_dev));
    }
}
```

### 7.3 使用示例
```bash
# 读取 LGA 检测状态
cat /sys/class/hw_power/lga_ck/status

# 返回值说明：
# 0  = 所有检测点正常（LGA_CK_FRACTURE_FREE）
# -1 = 发现 1 个异常点
# -2 = 发现 2 个异常点
# -N = 发现 N 个异常点
```

**实时检测特性**：
- 每次读取该节点时都会实时执行 `lga_status_check()`
- 不依赖后台定时检测，适用于工厂测试或手动诊断

---

## 八、典型应用场景

### 8.1 场景1：充电过程中 LGA 异常检测
```
时序流程：
1. 用户插入充电器
   ↓
2. POWER_NE_CHARGING_START 事件触发
   ↓
3. lga_ck_event_call() 调度延迟 30s 检测
   ↓
4. 30 秒后执行 lga_ck_detect_work()
   ↓
5. 检测所有配置的检测点（ADC/GPIO/IRQ）
   ↓
6. 发现异常：
   - ADC 通道 5 电压 = 2100mV (阈值 1500mV)
   - 状态 = LGA_CK_FRACTURE_FOUND
   ↓
7. 上报 DMD：
   - 错误码：25001
   - 信息："lga abnormal: adc_channel=5, adc_vol=2100[mV]"
   ↓
8. abnormal_time++ (异常计数 = 1)
```

### 8.2 场景2：中断触发的快速检测
```
时序流程：
1. 硬件异常导致 IRQ GPIO 产生下降沿
   ↓
2. lga_ck_interrupt() 中断处理函数执行
   ↓
3. 取消旧的检测任务（如果有）
   ↓
4. 调度延迟 30s 的新检测任务
   ↓
5. 30 秒后执行检测并上报 DMD
```

### 8.3 场景3：工厂测试手动检测
```bash
# 测试脚本示例
#!/bin/bash

echo "开始 LGA 检测..."

# 读取检测状态
status=$(cat /sys/class/hw_power/lga_ck/status)

if [ $status -eq 0 ]; then
    echo "PASS: LGA 连接正常"
    exit 0
else
    echo "FAIL: 发现 $((0-$status)) 个异常点"
    
    # 查看详细日志
    dmesg | grep "lga abnormal"
    
    exit 1
fi
```

### 8.4 场景4：异常上报限制机制
```
检测流程：
第 1 次异常 → DMD 上报 → abnormal_time = 1
第 2 次异常 → DMD 上报 → abnormal_time = 2
第 3 次异常 → DMD 上报 → abnormal_time = 3
第 4 次异常 → DMD 上报 → abnormal_time = 4
第 5 次异常 → DMD 上报 → abnormal_time = 5
第 6 次异常 → 检测被跳过（abnormal_time >= 5）
...
后续异常 → 全部被跳过

设计意图：
- 避免持续上报相同错误导致日志泛滥
- 异常设备已记录足够诊断信息
- 防止 DMD 服务过载
```

---

## 九、调试方法

### 9.1 日志关键点
```bash
# 1. 模块初始化日志
[lga_check] probe success

# 2. ADC 检测日志
[lga_check] adc_channel=5, adc_vol=2100
[lga_check] adc_vol is over threshold 1500

# 3. GPIO 检测日志
[lga_check] gpio_no=195, gpio_val=1
[lga_check] gpio_val is equal threshold 1

# 4. IRQ 检测日志
[lga_check] irq_gpio_no=196, irq_val=0
[lga_check] irq_val is equal threshold 0

# 5. DMD 上报日志
[lga_check] lga abnormal: adc_channel=5, adc_vol=2100[mV]

# 6. 上报次数限制日志
[lga_check] abnormal over 5 time

# 7. 检测启动日志
[lga_check] start check

# 8. ADC 读取失败日志
[lga_check] adc read channel 5 fail, time=1
[lga_check] adc read channel 5 fail, time=2
[lga_check] adc read channel 5 fail, time=3
```

### 9.2 Sysfs 调试
```bash
# 查看当前 LGA 状态
cat /sys/class/hw_power/lga_ck/status

# 持续监控（每秒检测一次）
watch -n 1 cat /sys/class/hw_power/lga_ck/status

# 触发充电事件检测
# 插拔充电器，观察 30 秒后的日志
```

### 9.3 DMD 查询
```bash
# 查看 DMD 上报记录
cat /sys/kernel/debug/power_dsm/power_dsm_dump

# 过滤 LGA 相关错误
cat /sys/kernel/debug/power_dsm/power_dsm_dump | grep "25001\|25002\|25003"
```

### 9.4 常见问题排查

#### 问题1：检测不触发
**现象**：充电时没有日志输出 "start check"

**排查步骤**：
1. 检查驱动是否加载：
   ```bash
   lsmod | grep lga_check
   ```
2. 检查 DTS 配置是否正确：
   ```bash
   cat /proc/device-tree/lga_check/check_para
   ```
3. 检查充电事件是否触发：
   ```bash
   dmesg | grep "CHARGING_START"
   ```

#### 问题2：ADC 读取失败
**现象**：日志显示 "adc read channel X fail, time=3"

**排查步骤**：
1. 检查 ADC 通道号是否正确
2. 检查 ADC 驱动是否就绪
3. 使用其他工具验证 ADC 通道：
   ```bash
   cat /sys/class/hwmon/hwmon0/device/adc_channel_5
   ```

#### 问题3：GPIO 无法申请
**现象**：probe 失败，返回 -EPROBE_DEFER

**排查步骤**：
1. 检查 GPIO 是否被其他模块占用：
   ```bash
   cat /sys/kernel/debug/gpio
   ```
2. 检查 Pinctrl 配置是否正确
3. 在工厂模式下测试（跳过 GPIO 申请）

#### 问题4：中断未触发
**现象**：硬件异常但中断处理函数未执行

**排查步骤**：
1. 检查中断是否注册成功：
   ```bash
   cat /proc/interrupts | grep lga
   ```
2. 检查 GPIO 中断配置：
   ```bash
   cat /sys/kernel/debug/gpio | grep <irq_gpio_no>
   ```
3. 手动触发中断（短接测试点到地）

---

## 十、总结

### 10.1 技术特点
1. **多模式融合**：ADC + GPIO + IRQ 三种检测方式互补
2. **事件驱动**：充电事件触发 + 中断触发双重机制
3. **防护机制**：上报次数限制、ADC 重试、延迟检测
4. **工厂兼容**：工厂模式特殊处理，避免 GPIO 冲突

### 10.2 设计亮点
- **延迟检测**：充电启动 30s 后检测，等待热稳态
- **DMD 防刷**：最多上报 5 次，避免日志泛滥
- **实时查询**：Sysfs 接口支持主动检测，适用于工厂测试
- **硬件解耦**：通过 DTS 配置检测点，无需修改代码

### 10.3 应用价值
- **提前预警**：在 LGA 完全失效前检测到异常
- **故障定位**：DMD 上报精确的检测点和异常值
- **质量控制**：工厂测试阶段发现 LGA 虚焊问题
- **用户保护**：防止 LGA 失效导致功能异常或安全隐患

### 10.4 适用硬件
- **折叠屏设备**：频繁折叠可能导致 LGA 疲劳断裂
- **大功率充电设备**：充电热应力可能引起 LGA 失效
- **跌落冲击场景**：机械冲击可能导致 LGA 接触不良
