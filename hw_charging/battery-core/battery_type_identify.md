---
outline: deep
---

# 华为电池核心之battery_type_identify 模块代码解析

## 模块概述

`battery_type_identify` 模块是华为电源管理子系统中的**电池类型识别驱动**，用于在 **ADC 电压识别模式**和 **单线通信（OneWire）SN 识别模式**之间切换，实现多种电池类型的智能识别。

**核心功能：**
- **双模式识别：** 支持 ID 电压识别（BAT_ID_VOLTAGE）和 ID 序列号识别（BAT_ID_SN）
- **GPIO + PMOS 控制：** 通过 GPIO 控制 PMOS 开关，切换识别通道
- **安全芯片接口：** 支持外部安全 IC 的 open/close 操作注册
- **多 IC 链表管理：** 支持多个电池类型识别 IC 的状态协调
- **调试接口：** 提供丰富的 debugfs 接口用于测试验证

**工作原理：**

```
                ┌─────────────────────────┐
                │  Battery Type Identify  │
                └────────┬────────────────┘
                         │
              ┌──────────┴──────────┐
              │                     │
       ┌──────▼──────┐       ┌─────▼──────┐
       │ ADC Voltage │       │  OneWire   │
       │   Mode      │       │  SN Mode   │
       └──────┬──────┘       └─────┬──────┘
              │                     │
        Close PMOS              Open PMOS
        Close IC                 Open IC
              │                     │
        ┌─────▼─────┐         ┌────▼─────┐
        │ Read ADC  │         │ Read SN  │
        │ Voltage   │         │ via 1W   │
        └───────────┘         └──────────┘
```

---

## 一、主要数据结构

### 1.1 GPIO 状态配置 `bat_type_gpio_state`

```c
struct bat_type_gpio_state {
    int direction;  // GPIO 方向：BAT_TYPE_GPIO_IN / BAT_TYPE_GPIO_OUT
    int value;      // GPIO 电平值：0/1
};
```

**说明：** 定义不同识别模式下的 GPIO 配置（方向 + 电平）。

### 1.2 安全 IC 操作接口 `bat_security_ic_ops`

```c
struct bat_security_ic_ops {
    int (*open_ic)(void);   // 打开安全 IC（OneWire 模式）
    int (*close_ic)(void);  // 关闭安全 IC（ADC 模式）
};
```

**用途：** 外部安全芯片（如 DS28E30、Maxim OneWire IC）向本模块注册控制接口。

### 1.3 主设备结构体 `bat_type_dev`

```c
struct bat_type_dev {
    struct mutex lock;                      // 模式切换互斥锁
    int gpio;                               // PMOS 控制 GPIO 号
    struct bat_type_gpio_state id_voltage;  // ADC 模式的 GPIO 配置
    struct bat_type_gpio_state id_sn;       // OneWire 模式的 GPIO 配置
    const struct bat_security_ic_ops *ops;  // 安全 IC 操作接口
    int cur_mode;                           // 当前识别模式
};
```

### 1.4 IC 注册链表节点 `batt_type_entry`

```c
struct batt_type_entry {
    struct list_head node;                  // 链表节点
    struct platform_device *ic_dev;         // IC 设备指针
    void (*set_work_status)(struct platform_device *pdev, int status);  
                                            // IC 状态设置回调
};
```

**说明：** 支持多个 OneWire IC 注册，统一管理工作状态。

---

## 二、识别模式

### 2.1 模式枚举 `bat_type_identify_mode`

| 模式 | 值 | PMOS 状态 | IC 状态 | 用途 |
|------|---|---------|---------|------|
| `BAT_ID_VOLTAGE` | 0 | 关闭（高电平） | close_ic | ADC 电压识别 |
| `BAT_ID_SN` | 1 | 打开（低电平） | open_ic | OneWire SN 识别 |
| `BAT_INVALID_MODE` | 2 | 无效 | - | 初始状态 |

### 2.2 模式切换流程

#### 2.2.1 ADC 电压模式（BAT_ID_VOLTAGE）

```c
bat_type_apply_mode(BAT_ID_VOLTAGE)
    ├─ mutex_lock()
    ├─ 设置所有 IC 为 IN 状态（BAT_TYPE_DEV_IN）
    ├─ gpio_direction_output(gpio, id_voltage.value)  // 关闭 PMOS
    ├─ ops->close_ic()  // 关闭安全 IC
    └─ cur_mode = BAT_ID_VOLTAGE

// 读取 ADC 电压
voltage = power_platform_get_battery_id_voltage()

bat_type_release_mode(true/false)
    ├─ if (flag) 强制切回 ADC 模式
    ├─ 设置所有 IC 为 LOW 状态（BAT_TYPE_DEV_LOW）
    └─ mutex_unlock()
```

#### 2.2.2 OneWire SN 模式（BAT_ID_SN）

```c
bat_type_apply_mode(BAT_ID_SN)
    ├─ mutex_lock()
    ├─ 设置所有 IC 为 IN 状态
    ├─ gpio_direction_output(gpio, id_sn.value)  // 打开 PMOS
    ├─ ops->open_ic()  // 打开安全 IC
    └─ cur_mode = BAT_ID_SN

// 读取 OneWire SN
get_battery_type(id_sn, BAT_TYPE_ID_SN_SIZE)

bat_type_release_mode(true/false)
    └─ 释放锁并可选恢复 ADC 模式
```

---

## 三、核心接口

### 3.1 模式申请 `bat_type_apply_mode()`

```c
void bat_type_apply_mode(int mode);
```

**功能：** 切换到指定识别模式并加锁，防止并发访问。

**参数：**
- `mode`: `BAT_ID_VOLTAGE` 或 `BAT_ID_SN`

**使用场景：**
```c
// 读取电池 ID 电压
bat_type_apply_mode(BAT_ID_VOLTAGE);
int voltage = power_platform_get_battery_id_voltage();
bat_type_release_mode(true);

// 读取电池序列号
bat_type_apply_mode(BAT_ID_SN);
unsigned char sn[6];
get_battery_type(sn, 6);
bat_type_release_mode(true);
```

**注意：** 必须与 `bat_type_release_mode()` 成对使用，否则会导致死锁。

### 3.2 模式释放 `bat_type_release_mode()`

```c
void bat_type_release_mode(bool flag);
```

**功能：** 释放模式锁，可选恢复到 ADC 模式。

**参数：**
- `flag`: 
  - `true`: 强制切换回 BAT_ID_VOLTAGE 模式（关闭 PMOS + IC）
  - `false`: 保持当前模式不变

**设计理念：**
- `flag=true` 用于单次识别后立即恢复（省电、保护 IC）
- `flag=false` 用于连续操作（如多次读取 SN 校验）

### 3.3 安全 IC 注册 `bat_security_ic_ops_register()`

```c
void bat_security_ic_ops_register(const struct bat_security_ic_ops *ops);
```

**功能：** 外部安全 IC 驱动注册控制接口。

**示例（OneWire IC 驱动）：**

```c
static int onewire_open_ic(void)
{
    // 使能 OneWire IC 电源
    regulator_enable(onewire_vdd);
    msleep(10);  // 等待 IC 上电稳定
    return 0;
}

static int onewire_close_ic(void)
{
    // 关闭 OneWire IC 电源
    regulator_disable(onewire_vdd);
    return 0;
}

static struct bat_security_ic_ops onewire_ops = {
    .open_ic = onewire_open_ic,
    .close_ic = onewire_close_ic,
};

// 在 OneWire IC 驱动的 probe 中注册
bat_security_ic_ops_register(&onewire_ops);
```

### 3.4 IC 链表注册 `bat_type_ic_register()`

```c
void bat_type_ic_register(struct batt_type_entry *entry);
```

**功能：** 将电池类型识别 IC 加入全局链表，统一管理工作状态。

**使用场景：** 多 IC 并行识别（如主电池和辅助电池各有 OneWire IC）。

---

## 四、GPIO 控制机制

### 4.1 GPIO 配置逻辑

```c
static int bat_type_set_gpio(int gpio, int direction, int value)
{
    if (direction == BAT_TYPE_GPIO_IN)
        return gpio_direction_input(gpio);  // 输入模式

    return gpio_direction_output(gpio, value);  // 输出模式 + 电平
}
```

### 4.2 典型 PMOS 控制电路

```
                   VDD_BAT
                      │
                      │
                 ┌────┴────┐
                 │  PMOS   │  ← GPIO 控制
                 └────┬────┘
                      │
           ┌──────────┴──────────┐
           │                     │
       ┌───▼───┐           ┌────▼────┐
       │  ADC  │           │ OneWire │
       │ (R分压)│           │   IC    │
       └───────┘           └─────────┘
           │                     │
          GND                   GND
```

**控制逻辑：**
- **GPIO=1（高电平）**: PMOS 截止 → ADC 通路导通 → ID 电压模式
- **GPIO=0（低电平）**: PMOS 导通 → OneWire IC 供电 → SN 识别模式

---

## 五、DTS 配置

### 5.1 配置示例

```
battery_type_identify {
    compatible = "huawei,battery-identify";
    
    /* PMOS 控制 GPIO */
    gpios = <&gpio25 3 0>;  // GPIO_205
    
    /* ADC 电压模式配置 */
    id_voltage_gpiov = <0 1>;  
        // direction=0 (输出), value=1 (高电平，关闭 PMOS)
    
    /* OneWire SN 模式配置 */
    id_sn_gpiov = <0 0>;       
        // direction=0 (输出), value=0 (低电平，打开 PMOS)
};
```

### 5.2 参数说明

| DTS 属性 | 类型 | 说明 |
|---------|------|------|
| `gpios` | gpio-specifier | PMOS 控制 GPIO（格式：&gpio_controller pin flags） |
| `id_voltage_gpiov` | u32[2] | ADC 模式 GPIO 配置 [方向, 电平] |
| `id_sn_gpiov` | u32[2] | OneWire 模式 GPIO 配置 [方向, 电平] |

### 5.3 DTS 解析代码

```c
bat_type_parse_dts()
    ├─ bat_type_parse_gpio()  // 解析 gpios 属性
    │    └─ power_gpio_request() → gpio 编号
    │
    ├─ bat_type_parse_channel("id_voltage_gpiov", &id_voltage)
    │    ├─ 读取 index 0 → direction
    │    └─ 读取 index 1 → value
    │
    └─ bat_type_parse_channel("id_sn_gpiov", &id_sn)
         ├─ 读取 index 0 → direction
         └─ 读取 index 1 → value
```

---

## 六、调试接口（debugfs）

### 6.1 接口列表

| debugfs 节点 | 功能 | 示例 |
|-------------|------|------|
| `identify_mode` | 查看当前识别模式 | `cat identify_mode` → "current mode is 1" |
| `id_voltage` | 读取 ID 电压 | `cat id_voltage` → "read id voltage is 350000 uV" |
| `id_sn` | 读取电池序列号 | `cat id_sn` → "read battery type is ATL123" |
| `id_sn_voltage` | 连续测试 SN+电压 | 循环读取 10 次并打印 |
| `open_ic` | 手动打开安全 IC | `cat open_ic` → "open ic pass" |
| `close_ic` | 手动关闭安全 IC | `cat close_ic` → "close ic pass" |
| `open_mos` | 手动打开 PMOS | `cat open_mos` → "open mos ret 0" |
| `close_mos` | 手动关闭 PMOS | `cat close_mos` → "close mos ret 0" |

### 6.2 使用示例

#### 6.2.1 测试 ADC 电压识别

```bash
# 自动切换到 ADC 模式并读取
cat /sys/kernel/debug/hwpower/bat_type/id_voltage
```

输出：
```
read id voltage is 350000
```

#### 6.2.2 测试 OneWire SN 识别

```bash
# 自动切换到 SN 模式并读取
cat /sys/kernel/debug/hwpower/bat_type/id_sn
```

输出：
```
read battery type is ATL456
```

#### 6.2.3 稳定性测试（连续读取 10 次）

```bash
cat /sys/kernel/debug/hwpower/bat_type/id_sn_voltage
```

输出：
```
0--ATL456--350000++
1--ATL456--350000++
2--ATL456--350000++
...
9--ATL456--350000++
read fine
```

#### 6.2.4 手动控制测试

```bash
# 手动打开 PMOS
cat /sys/kernel/debug/hwpower/bat_type/open_mos

# 手动打开 IC
cat /sys/kernel/debug/hwpower/bat_type/open_ic

# 读取 SN（需要外部调用 get_battery_type）
# ...

# 手动关闭 IC
cat /sys/kernel/debug/hwpower/bat_type/close_ic

# 手动关闭 PMOS
cat /sys/kernel/debug/hwpower/bat_type/close_mos
```

---

## 七、典型使用场景

### 7.1 场景 1：电池厂商识别

**需求：** 根据 ID 电压判断电池供应商（ATL/SDI/Coslight 等）。

**实现：**

```c
// 电池管理驱动中
bat_type_apply_mode(BAT_ID_VOLTAGE);
int voltage = power_platform_get_battery_id_voltage();
bat_type_release_mode(true);

// 电压范围判断（单位：uV）
if (voltage >= 300000 && voltage <= 400000)
    battery_vendor = "ATL";
else if (voltage >= 500000 && voltage <= 600000)
    battery_vendor = "SDI";
else if (voltage >= 700000 && voltage <= 800000)
    battery_vendor = "Coslight";
else
    battery_vendor = "Unknown";
```

### 7.2 场景 2：防伪验证（OneWire SN）

**需求：** 读取 OneWire IC 内的加密 SN 并验证真伪。

**实现：**

```c
// 防伪验证流程
bat_type_apply_mode(BAT_ID_SN);

unsigned char sn[6];
if (get_battery_type(sn, 6) == 0) {
    // 调用云端 API 验证 SN 真伪
    bool is_genuine = verify_battery_sn(sn);
    if (!is_genuine)
        report_fake_battery_alarm();
}

bat_type_release_mode(true);
```

### 7.3 场景 3：双电池独立识别

**需求：** 折叠屏双电池分别识别型号。

**实现：**

```c
// 主电池 IC 驱动注册
static void main_battery_set_status(struct platform_device *pdev, int status)
{
    if (status == BAT_TYPE_DEV_IN)
        enable_main_battery_ic();
    else
        disable_main_battery_ic();
}

static struct batt_type_entry main_entry = {
    .ic_dev = main_ic_pdev,
    .set_work_status = main_battery_set_status,
};
bat_type_ic_register(&main_entry);

// 辅助电池 IC 驱动注册（类似）
bat_type_ic_register(&aux_entry);

// 识别时自动协调双 IC 状态
bat_type_apply_mode(BAT_ID_SN);
get_battery_type(main_sn, 6);  // 主电池 SN
get_battery_type_aux(aux_sn, 6);  // 辅助电池 SN
bat_type_release_mode(true);
```

---

## 八、驱动生命周期

### 8.1 初始化流程 `bat_type_probe()`

```
1. 分配设备结构体：devm_kzalloc()
2. 初始化 cur_mode = BAT_INVALID_MODE
3. 解析 DTS：bat_type_parse_dts()
   ├─ 解析 PMOS 控制 GPIO
   ├─ 解析 id_voltage_gpiov（ADC 模式配置）
   └─ 解析 id_sn_gpiov（OneWire 模式配置）
4. 初始化互斥锁：mutex_init()
5. 注册全局设备：g_bat_type_dev = l_dev
6. 注册 debugfs 接口（CONFIG_HUAWEI_POWER_DEBUG 开启时）
```

### 8.2 卸载流程 `bat_type_remove()`

```
1. 销毁互斥锁：mutex_destroy()
2. 释放 GPIO：gpio_free()
3. 清空全局指针：g_bat_type_dev = NULL
```

### 8.3 模块加载优先级

```c
subsys_initcall_sync(bat_type_init);
```

**说明：** 使用 `subsys_initcall_sync` 确保在子系统初始化阶段加载，早于普通设备驱动，为后续电池识别提供基础。

---

## 九、锁机制设计

### 9.1 互斥锁保护

```c
void bat_type_apply_mode(int mode)
{
    mutex_lock(&l_dev->lock);  // 加锁
    // 切换模式操作...
    // 注意：不释放锁，等待 release_mode 释放
}

void bat_type_release_mode(bool flag)
{
    // 可选恢复 ADC 模式...
    mutex_unlock(&l_dev->lock);  // 释放锁
}
```

**设计目的：**
1. **防止并发切换：** 确保同一时刻只有一个任务在使用识别硬件
2. **保护 PMOS 状态：** 避免识别过程中 GPIO 被其他任务修改
3. **IC 状态同步：** 确保 IC 的 open/close 操作原子性

**使用注意：**
```c
// ✅ 正确用法（成对调用）
bat_type_apply_mode(BAT_ID_SN);
get_battery_type(sn, 6);
bat_type_release_mode(true);

// ❌ 错误用法（忘记释放锁 → 死锁）
bat_type_apply_mode(BAT_ID_SN);
get_battery_type(sn, 6);
// 忘记调用 bat_type_release_mode()
```

---

## 十、错误处理

### 10.1 常见错误场景

#### 10.1.1 GPIO 申请失败

```c
// probe 中检测
if (l_dev->gpio < 0) {
    hwlog_err("gpio request failed\n");
    goto free_mem;
}
```

**原因：**
- DTS 中 gpios 属性配置错误
- GPIO 已被其他驱动占用
- GPIO 控制器驱动未加载

#### 10.1.2 模式切换失败

```c
// bat_type_set_id_mos 中检测
if (ret) {
    hwlog_err("switch mode to %d error\n", mode);
    return;
}
```

**原因：**
- GPIO 方向设置失败
- PMOS 硬件故障

#### 10.1.3 IC 操作接口未注册

```c
// apply_mode 中安全处理
if (l_dev->ops && l_dev->ops->open_ic)
    l_dev->ops->open_ic();
```

**说明：** 即使 IC 驱动未注册，PMOS 控制仍能正常工作，确保基本的 ADC 识别功能。

---

## 十一、性能优化

### 11.1 模式保持策略

```c
// 避免重复切换
if (l_dev->cur_mode == mode)
    return;  // 已经是目标模式，无需操作
```

**优点：** 减少不必要的 GPIO 翻转和 IC 电源切换，降低功耗。

### 11.2 快速路径优化

```c
// 对于高频读取场景，可保持模式不恢复
bat_type_apply_mode(BAT_ID_VOLTAGE);
for (int i = 0; i < 100; i++) {
    voltage[i] = power_platform_get_battery_id_voltage();
    msleep(10);
}
bat_type_release_mode(true);  // 最后统一恢复
```

### 11.3 IC 链表遍历优化

```c
// bat_type_set_dev_status 使用高效的 list_for_each_entry
list_for_each_entry(pos, &batt_type_ic_head, node) {
    if (!pdev || !pos->set_work_status)
        continue;  // 跳过无效节点
    pos->set_work_status(pdev, status);
}
```

---

## 十二、调试技巧

### 12.1 查看当前模式

```bash
cat /sys/kernel/debug/hwpower/bat_type/identify_mode
```

输出示例：
```
current mode is 0  # BAT_ID_VOLTAGE
current mode is 1  # BAT_ID_SN
current mode is 2  # BAT_INVALID_MODE（初始状态）
```

### 12.2 验证 PMOS 控制

使用示波器或万用表测量 GPIO：

```bash
# 打开 PMOS（应测得 GPIO=0）
cat /sys/kernel/debug/hwpower/bat_type/open_mos

# 关闭 PMOS（应测得 GPIO=1）
cat /sys/kernel/debug/hwpower/bat_type/close_mos
```

### 12.3 验证 IC 控制

在 IC 驱动的 `open_ic/close_ic` 中添加日志：

```c
static int onewire_open_ic(void)
{
    hwlog_info("OneWire IC opened, VDD=%d\n", 
        regulator_get_voltage(onewire_vdd));
    // ...
}
```

### 12.4 诊断锁死问题

```bash
# 检查互斥锁持有者
cat /proc/$(pidof kworker)/stack | grep bat_type

# 强制释放（危险操作，仅调试用）
echo 1 > /sys/kernel/debug/hwpower/bat_type/force_unlock
```

### 12.5 动态日志控制

```bash
# 使能模块详细日志
echo 'file battery_type_identify.c +p' > /sys/kernel/debug/dynamic_debug/control

# 查看日志
dmesg | grep "batt_type_identify"
```

---

## 十三、关键宏定义

```c
#define BAT_TYPE_GPIO_OUT     0  // GPIO 输出模式
#define BAT_TYPE_GPIO_IN      1  // GPIO 输入模式
#define BAT_TYPE_ID_SN_SIZE   6  // OneWire SN 长度（字节）
#define BAT_TYPE_TEST_TIMES   10 // debugfs 稳定性测试次数
```

---

## 十四、总结

`battery_type_identify` 模块通过 **GPIO 控制 PMOS 开关** 和 **安全 IC 接口抽象**，实现了双模式电池识别机制。核心亮点包括：

1. **硬件抽象层：** 将 PMOS + IC 控制封装为统一接口，上层无需关心硬件细节
2. **互斥保护：** apply/release 成对调用 + 互斥锁，确保多任务环境下识别可靠性
3. **可扩展架构：** 支持多 IC 注册（链表管理），适配双电池等复杂场景
4. **调试友好：** 8 个 debugfs 接口覆盖所有测试场景，快速定位硬件问题
5. **容错设计：** IC 未注册时仍能进行 ADC 识别，保证基本功能

该模块是华为电池防伪验证和多厂商兼容的核心组件，广泛应用于旗舰手机和折叠屏设备中，确保了电池识别的准确性和安全性。