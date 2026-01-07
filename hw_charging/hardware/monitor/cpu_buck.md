---
outline: deep
---

# CPU BUCK 模块分析

## 1. 模块定位与核心价值

cpu_buck 是华为充电管理系统中的 **CPU BUCK（降压转换器）异常监测模块**，用于监测 CPU 供电 BUCK 芯片的故障状态，并在系统重启后上报异常信息。

**核心价值：**
- 🔍 **故障溯源**：系统重启后分析 CPU BUCK 异常原因
- 🛡️ **安全监测**：检测过压、欠压、过流、短路、过温等故障
- 📊 **DMD 上报**：自动上报 CPU BUCK 异常到设备监控系统
- 🔌 **多芯片支持**：支持 HI6422V100、HI6422V200、LP8758 等多款 BUCK 芯片

## 2. 系统架构

### 2.1 整体架构

```
┌─────────────────────────────────────────────────────────────┐
│                    系统重启前                                 │
├─────────────────────────────────────────────────────────────┤
│  CPU BUCK 芯片故障                                           │
│  ├─ 过流保护 (OCP)                                           │
│  ├─ 短路保护 (SCP)                                           │
│  ├─ 过温保护 (OTP)                                           │
│  ├─ 过压保护 (OVP)                                           │
│  └─ 欠压保护 (UVP)                                           │
│                                                             │
│  PMU 固件记录故障寄存器 → Bootloader 读取并传递              │
└──────────────────────┬──────────────────────────────────────┘
                       │ Cmdline 参数
                       ▼
┌─────────────────────────────────────────────────────────────┐
│                    系统重启后                                 │
├─────────────────────────────────────────────────────────────┤
│  Kernel 启动                                                 │
│  ↓                                                           │
│  early_param("cpu_buck_reg", ...)                           │
│  • 解析 cmdline 参数                                         │
│  • 提取故障寄存器值                                          │
│  • 设置检测标志                                              │
│  ↓                                                           │
│  各芯片驱动 probe                                            │
│  • hi6422v200_main_probe                                    │
│  • hi6422v200_aux_probe                                     │
│  • hi6422v100_probe                                         │
│  • lp8758_probe                                             │
│  ↓                                                           │
│  cpu_buck_register(&cbs)                                    │
│  • 注册到全局链表                                            │
│  ↓                                                           │
│  cpu_buck_probe                                             │
│  • 延迟 5s 启动监控工作                                      │
│  ↓                                                           │
│  cpu_buck_monitor_work                                      │
│  • 遍历所有注册的芯片                                        │
│  • 检查故障寄存器                                            │
│  • 上报 DMD 异常                                             │
└─────────────────────────────────────────────────────────────┘
```

### 2.2 Cmdline 参数格式

```
cpu_buck_reg=<type>_<reg_values>

格式说明：
• type: 4 位芯片类型编码
  - 0003: HI6422V100
  - 0004: LP8758
  - 0005: HI6422V200_MAIN
  - 0006: HI6422V200_AUX
• reg_values: 十六进制寄存器值（2 字节表示 1 个字节）

示例：
cpu_buck_reg=0005_010203
  ↓
type = 0005 (HI6422V200_MAIN)
reg[0] = 0x01
reg[1] = 0x02
reg[2] = 0x03
```

### 2.3 工作原理

```
系统崩溃前：
┌──────────────────────────────────┐
│  CPU BUCK 发生故障               │
│  (如 BUCK0 过流保护触发)          │
└────────┬─────────────────────────┘
         ▼
┌──────────────────────────────────┐
│  PMU 固件记录故障到寄存器         │
│  OCP_RECORD_REG[0] = 0x01        │
└────────┬─────────────────────────┘
         ▼
┌──────────────────────────────────┐
│  系统触发重启                     │
└────────┬─────────────────────────┘
         ▼
┌──────────────────────────────────┐
│  Bootloader 读取 PMU 寄存器      │
│  并传递到 kernel cmdline         │
│  cpu_buck_reg=0005_000100        │
└────────┬─────────────────────────┘
         ▼
┌──────────────────────────────────┐
│  Kernel 解析 cmdline             │
│  early_param 回调执行            │
└────────┬─────────────────────────┘
         ▼
┌──────────────────────────────────┐
│  驱动 probe 时注册到监控模块     │
└────────┬─────────────────────────┘
         ▼
┌──────────────────────────────────┐
│  延迟 5s 后分析并上报 DMD        │
│  "BUCK0_OCP 过流保护触发"        │
└──────────────────────────────────┘
```

## 3. 核心数据结构

### 3.1 错误信息结构

```c
struct cpu_buck_error_info {
    enum cpu_buck_error_number err_no;   // 错误编号
    char err_mask;                        // 错误位掩码
    int reg_num;                          // 寄存器索引
    char err_msg[MAX_ERR_MSG_LEN];        // 错误描述
};
```

**示例：**

```c
// HI6422V200 BUCK0 过流保护
{
    .err_no = HI6422V200_BUCK0_OCP,
    .err_mask = 0x01,         // bit0
    .reg_num = 1,             // 第 1 个寄存器
    .err_msg = "HI6422V200_BUCK0_OCP"
}
```

### 3.2 采样结构（链表节点）

```c
struct cpu_buck_sample {
    struct cpu_buck_sample *cbs;          // 下一个节点（链表）
    struct cpu_buck_error_info *cbi;      // 错误信息数组
    char *reg;                            // 寄存器值数组
    int info_size;                        // 错误信息数量
    enum cpu_buck_device_id dev_id;       // 设备 ID
};
```

**全局链表：**

```
g_cbs → HI6422V200_MAIN → HI6422V200_AUX → HI6422V100 → LP8758 → NULL
```

### 3.3 设备结构

```c
struct cpu_buck_dev {
    struct device *dev;                   // 设备指针
    struct delayed_work monitor_work;     // 监控工作队列
};
```

## 4. 支持的芯片与故障类型

### 4.1 HI6422V200（华为海思 PMU）

**主 PMU (MAIN)：**

| 寄存器 | 故障类型 | 位掩码 | 说明 |
|-------|---------|--------|------|
| np_irq1_record_reg | VSYS_PWRON_D60UR | 0x10 | 系统电压上电延迟 60us |
| | VSYS_OV_D200UR | 0x08 | 系统过压延迟 200us |
| | VSYS_PWROFF_ABS_2D | 0x04 | 系统掉电绝对值 2D |
| | THSD_OTMP125_D1MR | 0x02 | 过温 125℃ 延迟 1ms |
| | THSD_OTMP140_D180UR | 0x01 | 过温 140℃ 延迟 180us |
| np_ocp_record_reg | BUCK3_OCP | 0x08 | BUCK3 过流保护 |
| | BUCK2_OCP | 0x04 | BUCK2 过流保护 |
| | BUCK1_OCP | 0x02 | BUCK1 过流保护 |
| | BUCK0_OCP | 0x01 | BUCK0 过流保护 |
| np_scp_record_reg | BUCK3_SCP | 0x08 | BUCK3 短路保护 |
| | BUCK2_SCP | 0x04 | BUCK2 短路保护 |
| | BUCK1_SCP | 0x02 | BUCK1 短路保护 |
| | BUCK0_SCP | 0x01 | BUCK0 短路保护 |

**辅助 PMU (AUX)：** 类似配置

### 4.2 HI6422V100（华为海思旧版 PMU）

| 寄存器 | 故障类型 | 位掩码 | 说明 |
|-------|---------|--------|------|
| irq0 | VSYS_UV | 0x40 | 系统欠压 |
| | VSYS_OV | 0x20 | 系统过压 |
| | OTMP_R | 0x10 | 过温恢复 |
| | OTMP150_D10R | 0x08 | 过温 150℃ |
| | VBAT2P6_F | 0x04 | 电池 2.6V 故障 |
| | VBAT2P3_2D | 0x02 | 电池 2.3V 双检 |
| ocp_irq0 | BUCK34_SCP | 0x40 | BUCK3/4 短路 |
| | BUCK012_SCP | 0x20 | BUCK0/1/2 短路 |
| | OCPBUCK4~0 | 0x1F | BUCK4~0 过流 |
| ocp_irq1 | VBAT_OCPBUCK4~0 | 0x1F | 电池侧 BUCK 过流 |

### 4.3 LP8758（TI 芯片）

| 寄存器 | 故障类型 | 位掩码 | 说明 |
|-------|---------|--------|------|
| 0x18 | INT_BUCK3~0 | 0xF0 | BUCK3~0 中断 |
| | TDIE_SD | 0x08 | 芯片温度关断 |
| | TDIE_WARN | 0x04 | 芯片温度告警 |
| 0x19 | BUCK1_ILIM_INT | 0x10 | BUCK1 限流中断 |
| | BUCK0_PG_INT | 0x04 | BUCK0 电源良好中断 |
| | BUCK0_SC_INT | 0x02 | BUCK0 短路中断 |
| | BUCK0_ILIM_INT | 0x01 | BUCK0 限流中断 |

## 5. 核心流程实现

### 5.1 Cmdline 解析流程

```c
static int __init hi6422v200_main_parse_early_cmdline(char *p)
{
    char *start = NULL;
    int i;

    /* 步骤 1: 查找芯片类型标识 */
    start = strstr(p, HI6422V200_MAIN_TYPE);  // "0005_"
    if (start) {
        g_hi6422v200_main_flag = 1;  // 设置检测标志
        
        /* 步骤 2: 提取寄存器值（跳过前 5 个字符 "0005_"）*/
        cpu_buck_str_to_reg(start + 5, g_hi6422v200_main_val,
            HI6422V200_REG_SIZE);
        
        /* 步骤 3: 打印解析结果 */
        for (i = 0; i < HI6422V200_REG_SIZE; ++i)
            hwlog_info("reg[%d]=0x%x\n",
                i, g_hi6422v200_main_val[i]);
    } else {
        g_hi6422v200_main_flag = 0;  // 未发现异常
    }
    
    return 0;
}
early_param("cpu_buck_reg", hi6422v200_main_parse_early_cmdline);
```

**解析示例：**

```
输入: cpu_buck_reg=0005_010203

执行流程:
1. strstr 找到 "0005_"
2. start 指向 "0005_010203"
3. start + 5 指向 "010203"
4. cpu_buck_str_to_reg 转换:
   "01" → 0x01
   "02" → 0x02
   "03" → 0x03
5. g_hi6422v200_main_val = {0x01, 0x02, 0x03}
```

### 5.2 字符串转寄存器值

```c
void cpu_buck_str_to_reg(const char *str, char *reg, int size)
{
    unsigned char high;
    unsigned char low;
    int i, tmp_size;

    /* 计算实际转换字节数（2 个字符 = 1 个字节）*/
    tmp_size = strlen(str) / 2 > size ? size : strlen(str) / 2;
    
    for (i = 0; i < tmp_size; ++i) {
        /* 获取两个字符 */
        high = *(str + 2 * i);      // 第 i 个字节的高 4 位
        low = *(str + 2 * i + 1);   // 第 i 个字节的低 4 位
        
        /* 转换为数字 */
        high = power_change_char_to_digit(high);  // '0'~'9','A'~'F' → 0~15
        low = power_change_char_to_digit(low);
        
        /* 合并为一个字节 */
        *(reg + i) = (high << 4) | low;
    }
}
```

**转换示例：**

```
输入: "A5BC"

i=0:
  high = 'A' → 10 (0x0A)
  low  = '5' → 5  (0x05)
  reg[0] = (10 << 4) | 5 = 0xA5

i=1:
  high = 'B' → 11 (0x0B)
  low  = 'C' → 12 (0x0C)
  reg[1] = (11 << 4) | 12 = 0xBC

输出: reg = {0xA5, 0xBC}
```

### 5.3 注册到监控模块

```c
void cpu_buck_register(struct cpu_buck_sample *p_cbs)
{
    struct cpu_buck_sample *cbs = NULL;

    /* 步骤 1: 检查参数 */
    if (!p_cbs)
        return;

    /* 步骤 2: 如果是第一个节点，直接赋值 */
    if (!g_cbs) {
        g_cbs = p_cbs;
    } else {
        /* 步骤 3: 找到链表尾部 */
        cbs = g_cbs;
        while (cbs->cbs)
            cbs = cbs->cbs;
        
        /* 步骤 4: 追加到链表 */
        cbs->cbs = p_cbs;
    }
    
    hwlog_info("dev_id=%d, info_size=%d register ok\n",
        p_cbs->dev_id, p_cbs->info_size);
}
```

**链表构建过程：**

```
初始: g_cbs = NULL

注册 HI6422V200_MAIN:
  g_cbs → [MAIN | NULL]

注册 HI6422V200_AUX:
  g_cbs → [MAIN | ●] → [AUX | NULL]

注册 HI6422V100:
  g_cbs → [MAIN | ●] → [AUX | ●] → [V100 | NULL]

注册 LP8758:
  g_cbs → [MAIN | ●] → [AUX | ●] → [V100 | ●] → [LP8758 | NULL]
```

### 5.4 监控工作队列

```c
static void cpu_buck_monitor_work(struct work_struct *work)
{
    int i;
    struct cpu_buck_sample *cbs = g_cbs;
    char tmp_buf[MAX_ERR_MSG_LEN] = { 0 };

    /* 遍历链表中的所有芯片 */
    while (cbs) {
        hwlog_info("dev_id=%d, info_size=%d\n",
            cbs->dev_id, cbs->info_size);

        /* 遍历该芯片的所有错误信息 */
        for (i = 0; i < cbs->info_size; ++i) {
            /* 检查错误位是否匹配 */
            if ((cbs->cbi[i].err_mask &
                cbs->reg[cbs->cbi[i].reg_num]) !=
                cbs->cbi[i].err_mask)
                continue;  // 未触发，跳过
            
            /* 构造 DMD 上报消息 */
            snprintf(tmp_buf, MAX_ERR_MSG_LEN - 1,
                "cpu buck dev_id=%d, err_msg:%s\n",
                cbs->dev_id, cbs->cbi[i].err_msg);
            
            hwlog_info("buck exception happened: %s\n", tmp_buf);
            
            /* 上报 DMD */
            power_dsm_report_dmd(POWER_DSM_CPU_BUCK,
                POWER_DSM_ERROR_NO_CPU_BUCK_BASE + cbs->cbi[i].err_no,
                tmp_buf);
        }

        /* 下一个芯片 */
        cbs = cbs->cbs;
    }
}
```

**检测逻辑：**

```c
// 示例：检查 BUCK0_OCP
cbi[i].err_mask = 0x01
cbi[i].reg_num = 1
reg[1] = 0x03  (二进制: 0000 0011)

判断:
  (0x01 & 0x03) == 0x01
  (0x01) == 0x01
  → 匹配，触发 DMD 上报
```

**位掩码检测示例：**

```
寄存器值: reg[1] = 0x0F (二进制: 0000 1111)

检查项:
• BUCK0_OCP (0x01): 0x01 & 0x0F = 0x01 ✓ 触发
• BUCK1_OCP (0x02): 0x02 & 0x0F = 0x02 ✓ 触发
• BUCK2_OCP (0x04): 0x04 & 0x0F = 0x04 ✓ 触发
• BUCK3_OCP (0x08): 0x08 & 0x0F = 0x08 ✓ 触发

结果：所有 BUCK 都触发过流保护，上报 4 条 DMD
```

## 6. 典型应用场景

### 6.1 CPU 过流导致重启

**场景：** CPU 突然高负载，BUCK0 过流保护触发

```bash
# 系统运行中
CPU 负载突增 → BUCK0 电流超限 → OCP 触发 → 系统重启

# Bootloader 阶段
读取 PMU 寄存器: OCP_RECORD_REG = 0x01
设置 cmdline: cpu_buck_reg=0005_000100

# Kernel 启动
early_param 解析:
  g_hi6422v200_main_val[1] = 0x01

# 5s 后监控工作
检测到 BUCK0_OCP (0x01 & 0x01 = 0x01)
上报 DMD: "HI6422V200_BUCK0_OCP"
```

**DMD 上报内容：**
```
cpu buck dev_id=0, err_msg:HI6422V200_BUCK0_OCP
```

### 6.2 过温保护触发

**场景：** 芯片温度过高，触发 140℃ 关断

```bash
# 系统过热
芯片温度达到 140℃ → THSD_OTMP140 触发 → 系统重启

# Bootloader 传递
cpu_buck_reg=0005_010000

# Kernel 解析
g_hi6422v200_main_val[0] = 0x01

# 监控检测
检测到 THSD_OTMP140_D180UR (0x01 & 0x01 = 0x01)
上报 DMD: "HI6422V200_THSD_OTMP140"
```

### 6.3 短路保护触发

**场景：** BUCK2 输出短路

```bash
# 硬件短路
BUCK2 输出短接 → SCP 触发 → 系统重启

# Bootloader 传递
cpu_buck_reg=0005_000004

# Kernel 解析
g_hi6422v200_main_val[2] = 0x04

# 监控检测
检测到 BUCK2_SCP (0x04 & 0x04 = 0x04)
上报 DMD: "HI6422V200_BUCK2_SCP"
```

### 6.4 多故障同时触发

**场景：** 同时触发多个保护

```bash
# Cmdline
cpu_buck_reg=0005_020305

# 解析结果
reg[0] = 0x02  (THSD_OTMP125_D1MR)
reg[1] = 0x03  (BUCK0_OCP | BUCK1_OCP)
reg[2] = 0x05  (BUCK0_SCP | BUCK2_SCP)

# DMD 上报
1. HI6422V200_THSD_OTMP125
2. HI6422V200_BUCK0_OCP
3. HI6422V200_BUCK1_OCP
4. HI6422V200_BUCK0_SCP
5. HI6422V200_BUCK2_SCP
```

## 7. 调试方法

### 7.1 查看 Cmdline 参数

```bash
# 查看启动参数
cat /proc/cmdline | grep cpu_buck_reg

# 输出示例
cpu_buck_reg=0005_010203
```

### 7.2 日志分析

**使能动态日志：**

```bash
echo 'file cpu_buck*.c +p' > /sys/kernel/debug/dynamic_debug/control
```

**关键日志：**

```bash
# Cmdline 解析
[cpu_buck_hi6422v200_main] cpu_buck_reg=0005_010203
[cpu_buck_hi6422v200_main] reg[0]=0x1
[cpu_buck_hi6422v200_main] reg[1]=0x2
[cpu_buck_hi6422v200_main] reg[2]=0x3

# 注册
[cpu_buck] dev_id=0, info_size=13 register ok

# 监控检测
[cpu_buck] dev_id=0, info_size=13
[cpu_buck] buck exception happened: cpu buck dev_id=0, err_msg:HI6422V200_THSD_OTMP125_D1MR
```

### 7.3 手动触发测试

**修改 Cmdline（仅测试）：**

```bash
# 在 Bootloader 中添加测试参数
setenv bootargs "... cpu_buck_reg=0005_010203"
```

### 7.4 故障诊断流程

```
问题：系统异常重启
  ├─ 1. 检查 cmdline 是否有 cpu_buck_reg
  │    └─ cat /proc/cmdline | grep cpu_buck
  │
  ├─ 2. 分析寄存器值
  │    ├─ 识别芯片类型 (0003/0004/0005/0006)
  │    └─ 解析故障位
  │
  ├─ 3. 查看 kernel 日志
  │    └─ dmesg | grep cpu_buck
  │
  ├─ 4. 查看 DMD 上报
  │    └─ 确认具体故障类型
  │
  └─ 5. 定位硬件问题
       ├─ 过流 → 检查 CPU 负载/电源设计
       ├─ 短路 → 检查硬件连接
       ├─ 过温 → 检查散热设计
       └─ 过压/欠压 → 检查电源输入
```

## 8. 设计亮点

### 8.1 Early Param 机制

**问题：** 需要尽早获取重启前的故障信息

**解决方案：** 使用 `early_param` 在内核初始化早期解析 cmdline

```c
early_param("cpu_buck_reg", hi6422v200_main_parse_early_cmdline);
```

**优点：**
- ✅ 在设备驱动 probe 前获取数据
- ✅ 避免数据丢失
- ✅ 支持多个芯片独立解析

### 8.2 链表注册机制

**问题：** 支持多个 BUCK 芯片共存

**解决方案：** 链表管理多个芯片实例

```c
g_cbs → MAIN → AUX → V100 → LP8758 → NULL
```

**优点：**
- ✅ 动态添加芯片
- ✅ 统一监控接口
- ✅ 灵活扩展

### 8.3 延迟检测机制

**问题：** 系统启动时服务未完全就绪

**解决方案：** 延迟 5 秒后检测

```c
schedule_delayed_work(&di->monitor_work, DELAY_TIME_FOR_WORK);  // 5000ms
```

**优点：**
- ✅ 确保 DMD 服务已启动
- ✅ 避免上报失败
- ✅ 不阻塞系统启动

### 8.4 位掩码检测

**问题：** 一个寄存器包含多个故障位

**解决方案：** 位掩码精确匹配

```c
if ((err_mask & reg[reg_num]) == err_mask)
    // 故障触发
```

**优点：**
- ✅ 精确识别多个并发故障
- ✅ 减少误报
- ✅ 支持组合故障

### 8.5 字符串转二进制

**问题：** Cmdline 只能传递字符串

**解决方案：** 十六进制字符串转二进制

```c
"A5" → 0xA5
```

**优点：**
- ✅ 压缩传输数据
- ✅ 可读性好
- ✅ 易于调试

## 9. 支持的故障类型总结

### 9.1 电压相关

| 故障类型 | 说明 | 影响 |
|---------|------|------|
| VSYS_OV | 系统过压 | 可能损坏芯片 |
| VSYS_UV | 系统欠压 | 系统不稳定 |
| VSYS_PWROFF | 系统掉电 | 异常关机 |

### 9.2 温度相关

| 故障类型 | 说明 | 影响 |
|---------|------|------|
| THSD_OTMP125 | 过温 125℃ | 降频保护 |
| THSD_OTMP140 | 过温 140℃ | 紧急关断 |
| TDIE_WARN | 芯片温度告警 | 性能下降 |
| TDIE_SD | 芯片温度关断 | 系统重启 |

### 9.3 电流相关

| 故障类型 | 说明 | 影响 |
|---------|------|------|
| BUCK0~4_OCP | BUCK 过流保护 | CPU 供电不足 |
| BUCK0~4_SCP | BUCK 短路保护 | 硬件故障 |
| ILIM_INT | 限流中断 | 电流受限 |

## 10. 总结

cpu_buck 模块是华为充电管理系统中的 **CPU 供电故障追溯组件**，通过以下设计实现了可靠的故障监测：

**核心特性：**
1. ✅ **故障溯源**：系统重启后分析 CPU BUCK 异常原因
2. ✅ **Early Param**：内核早期获取 Bootloader 传递的故障信息
3. ✅ **多芯片支持**：链表管理 HI6422V100/V200、LP8758 等多款芯片
4. ✅ **精确检测**：位掩码机制精确识别多个并发故障
5. ✅ **自动上报**：DMD 自动上报，便于远程诊断

**应用价值：**
- 🔍 **故障定位**：快速识别 CPU 供电异常原因（过流/短路/过温）
- 🛡️ **质量监控**：统计 BUCK 故障频率，改进硬件设计
- 📊 **售后支持**：DMD 数据辅助售后问题诊断
- 🔧 **研发调试**：开发阶段快速定位电源问题

**典型应用：**
- 💻 CPU 高负载导致 BUCK 过流保护
- 🔥 散热不良导致过温保护触发
- ⚡ 硬件短路导致 BUCK SCP 保护
- 📱 系统异常重启的故障分析

该模块充分体现了 **故障记录与追溯** 的设计思想，是 CPU 供电系统可靠性监测的重要组件。