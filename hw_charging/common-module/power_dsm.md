---
outline: deep
---

# Power DSM 设备状态监控模块分析

## 1. 模块定位与核心价值

### 1.1 DSM 技术概述

**DSM（Device Status Monitor）** 是华为自研的设备状态监控系统，用于**收集、上报和分析设备异常**，帮助研发团队定位问题和优化产品质量。

Power DSM 是 DSM 系统在**电源子系统的具体实现**，负责监控和上报充电、电池、电源管理等模块的异常状态。

**核心价值：**
```
设备端异常检测 → DSM 上报 → 云端大数据分析 → 问题定位 → 固件优化
```

### 1.2 问题域

电源系统的异常通常难以复现和调试：

**典型问题场景：**
- 用户反馈：充电速度突然变慢
- 实际原因：温度过高触发限流保护
- 问题痛点：用户无法描述具体情况，研发无法重现

**DSM 解决方案：**
```
异常发生时：
├─ 检测到温度 > 45°C
├─ 触发充电电流限制
├─ 自动记录：温度、电流、电池 SOC、充电模式等
└─ 上报到云端（DSM 服务器）

研发团队：
├─ 云端查看 DSM 报告
├─ 分析触发条件和频率
├─ 定位根因（散热设计问题/算法bug）
└─ 优化固件（调整温度阈值/改进散热策略）
```

### 1.3 系统架构

```
┌─────────────────────────────────────────────────────┐
│  Power DSM 模块 (cc_common_module/power_dsm)        │
│                                                      │
│  ┌────────────────────────────────────────────┐    │
│  │  DSM Client 管理（16种客户端类型）          │    │
│  │  ├─ CPU Buck DSM         (CPU 电源异常)     │    │
│  │  ├─ USB DSM              (USB 异常)         │    │
│  │  ├─ Battery DSM          (电池异常)         │    │
│  │  ├─ Charge Monitor DSM   (充电监控)        │    │
│  │  ├─ Direct Charge DSM    (直充异常)         │    │
│  │  ├─ PD DSM               (PD 协议异常)      │    │
│  │  └─ ... (共16种)                            │    │
│  └────────────────────────────────────────────┘    │
│                                                      │
│  ┌────────────────────────────────────────────┐    │
│  │  上报接口                                   │    │
│  │  ├─ power_dsm_report_dmd()   (DMD上报)     │    │
│  │  ├─ power_dsm_report_hiview() (HiView上报) │    │
│  │  └─ power_dsm_dump_data()     (批量dump)   │    │
│  └────────────────────────────────────────────┘    │
│                                                      │
│  ┌────────────────────────────────────────────┐    │
│  │  调试接口                                   │    │
│  │  /sys/class/hw_power/power_dsm/info        │    │
│  └────────────────────────────────────────────┘    │
└─────────────────────────────────────────────────────┘
                    ↓
┌─────────────────────────────────────────────────────┐
│  Hiview Hievent 框架 (内核事件上报接口)             │
└─────────────────────────────────────────────────────┘
                    ↓
┌─────────────────────────────────────────────────────┐
│  用户空间 DSM Daemon (采集并上传到云端)             │
└─────────────────────────────────────────────────────┘
                    ↓
┌─────────────────────────────────────────────────────┐
│  华为云端 DSM 服务器 (大数据分析平台)               │
└─────────────────────────────────────────────────────┘
```

---

## 2. DSM Client 类型体系

### 2.1 客户端类型定义

```c
enum power_dsm_type {
    POWER_DSM_CPU_BUCK,              // CPU 电源芯片异常
    POWER_DSM_USB,                   // USB 接口异常
    POWER_DSM_BATTERY_DETECT,        // 电池检测异常
    POWER_DSM_BATTERY,               // 电池状态异常
    POWER_DSM_CHARGE_MONITOR,        // 充电监控异常
    POWER_DSM_SUPERSWITCH,           // 超级快充开关异常
    POWER_DSM_SMPL,                  // SMPL（突然掉电）异常
    POWER_DSM_PD_RICHTEK,            // Richtek PD 芯片异常
    POWER_DSM_PD,                    // PD 协议异常
    POWER_DSM_USCP,                  // USB 短路保护异常
    POWER_DSM_PMU_OCP,               // PMU 过流保护异常
    POWER_DSM_PMU_BMS,               // PMU 电量计异常
    POWER_DSM_PMU_IRQ,               // PMU 中断异常
    POWER_DSM_VIBRATOR_IRQ,          // 振动马达异常
    POWER_DSM_DIRECT_CHARGE_SC,      // 直充（SC模式）异常
    POWER_DSM_FCP_CHARGE,            // FCP 快充异常
    POWER_DSM_MTK_SWITCH_CHARGE2,    // MTK 平台充电异常
    POWER_DSM_LIGHTSTRAP,            // 智能皮套异常
};
```

### 2.2 客户端注册表

```c
static struct power_dsm_client g_power_dsm_client_data[] = {
    { POWER_DSM_CPU_BUCK, "dsm_cpu_buck", NULL, &g_power_dsm_dev_cpu_buck },
    { POWER_DSM_USB, "dsm_usb", NULL, &g_power_dsm_dev_usb },
    { POWER_DSM_BATTERY_DETECT, "dsm_battery_detect", NULL, &g_power_dsm_dev_battery_detect },
    { POWER_DSM_BATTERY, "dsm_battery", NULL, &g_power_dsm_dev_battery },
    { POWER_DSM_CHARGE_MONITOR, "dsm_charge_monitor", NULL, &g_power_dsm_dev_charge_monitor },
    // ... 共16种
};
```

**客户端属性：**
- `type`：客户端类型枚举值
- `name`：客户端名称（DSM 系统中的标识符）
- `client`：DSM 客户端实例（运行时注册）
- `dev`：DSM 设备结构（定义缓冲区大小等属性）

### 2.3 缓冲区大小配置

不同类型的异常需要记录的信息量不同，因此缓冲区大小也不同：

```c
// 电池异常 - 需要记录详细信息（2KB）
static struct dsm_dev g_power_dsm_dev_battery = {
    .name = "dsm_battery",
    .buff_size = POWER_DSM_BUF_SIZE_2048,  // 2048 字节
};

// 充电监控 - 中等信息量（1KB）
static struct dsm_dev g_power_dsm_dev_charge_monitor = {
    .name = "dsm_charge_monitor",
    .buff_size = POWER_DSM_BUF_SIZE_1024,  // 1024 字节
};

// USB 异常 - 简单信息（256B）
static struct dsm_dev g_power_dsm_dev_usb = {
    .name = "dsm_usb",
    .buff_size = POWER_DSM_BUF_SIZE_0256,  // 256 字节
};

// 智能皮套 - 最小信息（128B）
static struct dsm_dev g_power_dsm_dev_lightstrap = {
    .name = "dsm_lightstrap",
    .buff_size = POWER_DSM_BUF_SIZE_0128,  // 128 字节
};
```

---

## 3. 错误码体系

### 3.1 错误码定义策略

Power DSM 定义了 **100+ 种错误码**，覆盖电源系统的各种异常场景：

**错误码分类：**

#### 电池异常（Battery）
```c
POWER_DSM_ERROR_BATT_ACR_OVER_THRESHOLD           // 电池 ACR 超阈值
POWER_DSM_ERROR_BATT_TEMP_LOW                     // 电池温度过低
POWER_DSM_ERROR_BATT_SOC_CHANGE_FAST              // SOC 变化过快
POWER_DSM_ERROR_BATT_TERMINATE_TOO_EARLY          // 充电提前终止
POWER_DSM_ERROR_BATTERY_POLAR_ISHORT              // 电池极性短路
POWER_DSM_BATTERY_HEATING                         // 电池发热异常
POWER_DSM_BATTERY_ROM_ID_CERTIFICATION_FAIL       // 电池 ROM ID 认证失败
POWER_DSM_BATTERY_IC_KEY_CERTIFICATION_FAIL       // 电池 IC 密钥认证失败
POWER_DSM_UNMATCH_BATTERYS                        // 电池不匹配
```

#### 充电器异常（Charger）
```c
POWER_DSM_ERROR_CHARGE_I2C_RW                     // 充电器 I2C 读写失败
POWER_DSM_ERROR_WEAKSOURCE_STOP_CHARGE            // 弱源停止充电
POWER_DSM_ERROR_BOOST_OCP                         // Boost OCP（过流保护）
POWER_DSM_ERROR_NON_STANDARD_CHARGER_PLUGGED      // 非标准充电器插入
```

#### 快充协议异常（FCP/Direct Charge）
```c
POWER_DSM_ERROR_SWITCH_ATTACH                     // FCP 握手失败
POWER_DSM_ERROR_FCP_OUTPUT                        // FCP 输出异常
POWER_DSM_ERROR_FCP_DETECT                        // FCP 检测失败
POWER_DSM_ERROR_ADAPTER_OVLT                      // 适配器过压
POWER_DSM_ERROR_ADAPTER_OCCURRENT                 // 适配器过流
POWER_DSM_ERROR_ADAPTER_OTEMP                     // 适配器过温
POWER_DSM_DIRECT_CHARGE_ADAPTER_OTP               // 直充适配器过温
POWER_DSM_DIRECT_CHARGE_VOL_ACCURACY              // 直充电压精度异常
POWER_DSM_DIRECT_CHARGE_FULL_PATH_RESISTANCE      // 直充全路径电阻异常
```

#### 直充故障细分（SC/LVC）
```c
POWER_DSM_DIRECT_CHARGE_SC_FAULT_VBUS_OVP         // SC VBUS 过压
POWER_DSM_DIRECT_CHARGE_SC_FAULT_TSBAT_OTP        // SC 电池温度过温
POWER_DSM_DIRECT_CHARGE_SC_FAULT_TSBUS_OTP        // SC 总线温度过温
POWER_DSM_DIRECT_CHARGE_SC_FAULT_TDIE_OTP         // SC 芯片温度过温
POWER_DSM_DIRECT_CHARGE_SC_FAULT_AC_OVP           // SC AC 过压
POWER_DSM_DIRECT_CHARGE_SC_FAULT_VBAT_OVP         // SC 电池过压
POWER_DSM_DIRECT_CHARGE_SC_FAULT_IBAT_OCP         // SC 电池过流
POWER_DSM_DIRECT_CHARGE_SC_FAULT_IBUS_OCP         // SC 总线过流
POWER_DSM_DIRECT_CHARGE_SC_FAULT_CONV_OCP         // SC 转换器过流
```

#### USB 异常
```c
POWER_DSM_ERROR_NO_USB_SHORT_PROTECT              // USB 短路保护触发
POWER_DSM_ERROR_NO_USB_SHORT_PROTECT_NTC          // USB 短路保护（NTC）
POWER_DSM_ERROR_NO_USB_SHORT_PROTECT_HIZ          // USB 短路保护（HIZ）
POWER_DSM_ERROR_NO_WATER_CHECK_IN_USB             // USB 进水检测
```

#### 无线充电异常
```c
POWER_DSM_ERROR_WIRELESS_BOOSTING_FAIL            // 无线充电 Boost 失败
POWER_DSM_ERROR_WIRELESS_CERTI_COMM_FAIL          // 无线充电认证通信失败
POWER_DSM_ERROR_WIRELESS_CHECK_TX_ABILITY_FAIL    // 无线充电 TX 能力检查失败
POWER_DSM_ERROR_WIRELESS_RX_OCP                   // 无线充电接收端过流
POWER_DSM_ERROR_WIRELESS_RX_OVP                   // 无线充电接收端过压
POWER_DSM_ERROR_WIRELESS_RX_OTP                   // 无线充电接收端过温
POWER_DSM_ERROR_WIRELESS_TX_POWER_SUPPLY_FAIL     // 无线发射端供电失败
POWER_DSM_ERROR_WIRELESS_TX_BATTERY_OVERHEAT      // 无线发射端电池过热
```

#### 双电池异常（Dual Battery）
```c
POWER_DSM_DUAL_BATTERY_CURRENT_BIAS_DETECT        // 双电池电流偏差
POWER_DSM_DUAL_BATTERY_OUT_OF_POSITION_DETECTION  // 双电池位置异常
POWER_DSM_DUAL_BATTERY_CAPACITY_DIFFERENT_DETECT  // 双电池容量不一致
POWER_DSM_MULTI_CHARGE_CURRENT_RATIO_INFO         // 多路充电电流比例信息
POWER_DSM_MULTI_CHARGE_CURRENT_RATIO_WARNING      // 多路充电电流比例告警
POWER_DSM_MULTI_CHARGE_CURRENT_RATIO_ERROR        // 多路充电电流比例错误
```

---

## 4. 核心 API 详解

### 4.1 基础上报接口

#### power_dsm_report_dmd()

**功能：** 上报 DMD（Device Malfunction Detection）异常

```c
int power_dsm_report_dmd(unsigned int type, int err_no, const char *buf)
```

**参数说明：**
- `type`：DSM 客户端类型（如 `POWER_DSM_BATTERY`）
- `err_no`：错误码（如 `POWER_DSM_ERROR_BATT_TEMP_LOW`）
- `buf`：异常信息字符串（详细描述）

**工作流程：**
```c
int power_dsm_report_dmd(unsigned int type, int err_no, const char *buf)
{
    struct dsm_client *client = power_dsm_get_dclient(type);

    if (!client || !buf) {
        hwlog_err("client or buf is null\n");
        return -EPERM;
    }

    // 检查客户端是否空闲（非阻塞）
    if (!dsm_client_ocuppy(client)) {
        // 记录错误信息
        dsm_client_record(client, "%s", buf);
        
        // 通知 DSM 系统
        dsm_client_notify(client, err_no);
        
        hwlog_info("report type:%d, err_no:%d\n", type, err_no);
        return 0;
    }

    // 客户端忙（上次上报尚未处理完）
    hwlog_err("power dsm client is busy\n");
    return -EPERM;
}
```

**使用示例：**
```c
// 检测到电池温度过低
int temp = get_battery_temp();
if (temp < -10) {  // -10°C
    char buf[256];
    snprintf(buf, sizeof(buf), 
             "Battery temp too low: %d, SOC=%d, voltage=%dmV\n",
             temp, get_battery_soc(), get_battery_voltage());
    
    power_dsm_report_dmd(POWER_DSM_BATTERY, 
                         POWER_DSM_ERROR_BATT_TEMP_LOW, 
                         buf);
}
```

#### power_dsm_report_format_dmd()

**功能：** 格式化上报（宏定义，支持可变参数）

```c
#define power_dsm_report_format_dmd(type, err_no, fmt, args...) do { \
    if (power_dsm_get_dclient(type)) { \
        if (!dsm_client_ocuppy(power_dsm_get_dclient(type))) { \
            dsm_client_record(power_dsm_get_dclient(type), fmt, ##args); \
            dsm_client_notify(power_dsm_get_dclient(type), err_no); \
            pr_info("report type:%d, err_no:%d\n", type, err_no); \
        } else { \
            pr_err("power dsm client is busy\n"); \
        } \
    } \
} while (0)
```

**使用示例：**
```c
// 直接使用 printf 风格格式化
power_dsm_report_format_dmd(POWER_DSM_BATTERY, 
                            POWER_DSM_ERROR_BATT_SOC_CHANGE_FAST,
                            "SOC change too fast: from %d%% to %d%% in %d seconds\n",
                            old_soc, new_soc, delta_time);
```

### 4.2 HiView 上报接口

```c
int power_dsm_report_hiview(unsigned int err_no, const char *key, const char *value)
```

**功能：** 通过 HiView 事件框架上报（键值对形式）

**使用场景：** 结构化数据上报

```c
int power_dsm_report_hiview(unsigned int err_no, const char *key, const char *value)
{
    int ret;
    struct hiview_hievent *hi_event = NULL;

    if (!key || !value)
        return -EPERM;

    // 创建 HiView 事件
    hi_event = hiview_hievent_create(err_no);
    if (!hi_event) {
        hwlog_err("create hievent fail\n");
        return -EPERM;
    }

    // 添加键值对
    hiview_hievent_put_string(hi_event, key, value);
    
    // 上报事件
    ret = hiview_hievent_report(hi_event);
    if (ret <= 0) {
        hwlog_err("hievent report fail\n");
        hiview_hievent_destroy(hi_event);
        return -EPERM;
    }

    hiview_hievent_destroy(hi_event);
    hwlog_info("err_no=%d key=%s value=%s\n", err_no, key, value);
    return 0;
}
```

**使用示例：**
```c
// 上报充电器类型
power_dsm_report_hiview(CHARGER_TYPE_EVENT_ID, 
                        "charger_type", 
                        "FCP_CHARGER");

// 上报直充模式
power_dsm_report_hiview(DIRECT_CHARGE_MODE_EVENT_ID, 
                        "dc_mode", 
                        "SC_2to1");
```

### 4.3 批量 Dump 接口

#### power_dsm_dump_data()

**功能：** 批量转储数据（用于周期性或触发式数据收集）

```c
struct power_dsm_dump {
    unsigned int type;                // DSM 客户端类型
    int error_no;                     // 错误码
    bool dump_enable;                 // 是否使能转储
    bool dump_always;                 // 是否总是转储（不会自动禁用）
    const char *pre_buf;              // 前缀字符串
    bool (*support)(void);            // 平台支持检查回调
    void (*dump)(char *buf, unsigned int buf_len);       // 转储回调
    bool (*check_error)(char *buf, unsigned int buf_len); // 错误检查回调
};
```

**使用示例：**
```c
// 定义转储配置数组
static bool check_battery_error(char *buf, unsigned int buf_len)
{
    int temp = get_battery_temp();
    int soc = get_battery_soc();
    
    if (temp < 0 || temp > 50) {
        snprintf(buf, buf_len, "temp=%d ", temp);
        return true;  // 有错误，继续转储
    }
    
    return false;  // 无错误，跳过转储
}

static void dump_battery_info(char *buf, unsigned int buf_len)
{
    int used = strlen(buf);
    int unused = buf_len - used;
    
    snprintf(buf + used, unused, 
             "SOC=%d%% voltage=%dmV current=%dmA cycle=%d\n",
             get_battery_soc(),
             get_battery_voltage(),
             get_battery_current(),
             get_battery_cycle());
}

static struct power_dsm_dump battery_dump_table[] = {
    {
        .type = POWER_DSM_BATTERY,
        .error_no = POWER_DSM_ERROR_BATT_TEMP_LOW,
        .dump_enable = true,
        .dump_always = false,  // 上报一次后禁用
        .pre_buf = "Battery Abnormal",
        .support = NULL,
        .check_error = check_battery_error,
        .dump = dump_battery_info,
    },
};

// 触发转储
void battery_monitor_work(void)
{
    // 转储所有使能的项
    power_dsm_dump_data(battery_dump_table, 
                        ARRAY_SIZE(battery_dump_table));
}

// 重置使能状态（用于新的监控周期）
void battery_monitor_reset(void)
{
    power_dsm_reset_dump_enable(battery_dump_table, 
                                 ARRAY_SIZE(battery_dump_table));
}
```

---

## 5. 典型应用场景

### 5.1 充电异常监控

**场景：** 检测到充电电流异常低

```c
void charge_monitor_work(void)
{
    int ibat = get_battery_current();
    int vbus = get_vbus_voltage();
    int usb_type = get_usb_type();
    
    // DCP 充电器但电流低于 500mA
    if (usb_type == USB_DCP && ibat < 500) {
        char buf[512];
        
        snprintf(buf, sizeof(buf),
                 "Low charging current detected\n"
                 "USB Type: %s\n"
                 "Vbus: %d mV\n"
                 "Ibat: %d mA (expected > 1500mA)\n"
                 "Battery SOC: %d%%\n"
                 "Battery Temp: %d C\n"
                 "Charger IC: %s\n",
                 get_usb_type_string(usb_type),
                 vbus,
                 ibat,
                 get_battery_soc(),
                 get_battery_temp() / 10,
                 get_charger_ic_name());
        
        power_dsm_report_dmd(POWER_DSM_CHARGE_MONITOR,
                             POWER_DSM_ERROR_WEAKSOURCE_STOP_CHARGE,
                             buf);
    }
}
```

### 5.2 直充故障上报

**场景：** 直充过程中检测到 SC 芯片过温

```c
void direct_charge_fault_handler(int fault_type)
{
    char buf[1024];
    int offset = 0;
    
    // 构造详细错误信息
    offset += snprintf(buf + offset, sizeof(buf) - offset,
                       "Direct Charge SC Fault Detected\n");
    
    offset += snprintf(buf + offset, sizeof(buf) - offset,
                       "Fault Type: TDIE_OTP (Die Temperature Over Temperature)\n");
    
    offset += snprintf(buf + offset, sizeof(buf) - offset,
                       "Timestamp: %lld ms\n", ktime_to_ms(ktime_get_boottime()));
    
    offset += snprintf(buf + offset, sizeof(buf) - offset,
                       "Adapter Info:\n");
    offset += snprintf(buf + offset, sizeof(buf) - offset,
                       "  - Type: %s\n", get_adapter_type_string());
    offset += snprintf(buf + offset, sizeof(buf) - offset,
                       "  - Voltage: %d mV\n", get_adapter_voltage());
    offset += snprintf(buf + offset, sizeof(buf) - offset,
                       "  - Current: %d mA\n", get_adapter_current());
    
    offset += snprintf(buf + offset, sizeof(buf) - offset,
                       "Battery Info:\n");
    offset += snprintf(buf + offset, sizeof(buf) - offset,
                       "  - Voltage: %d mV\n", get_battery_voltage());
    offset += snprintf(buf + offset, sizeof(buf) - offset,
                       "  - Current: %d mA\n", get_battery_current());
    offset += snprintf(buf + offset, sizeof(buf) - offset,
                       "  - SOC: %d%%\n", get_battery_soc());
    offset += snprintf(buf + offset, sizeof(buf) - offset,
                       "  - Temp: %d C\n", get_battery_temp() / 10);
    
    offset += snprintf(buf + offset, sizeof(buf) - offset,
                       "SC IC Info:\n");
    offset += snprintf(buf + offset, sizeof(buf) - offset,
                       "  - IC Name: %s\n", get_sc_ic_name());
    offset += snprintf(buf + offset, sizeof(buf) - offset,
                       "  - Die Temp: %d C (Threshold: 120 C)\n", 
                       get_sc_die_temp());
    offset += snprintf(buf + offset, sizeof(buf) - offset,
                       "  - VBUS: %d mV\n", get_sc_vbus());
    offset += snprintf(buf + offset, sizeof(buf) - offset,
                       "  - IBUS: %d mA\n", get_sc_ibus());
    
    // 上报 DSM
    power_dsm_report_dmd(POWER_DSM_DIRECT_CHARGE_SC,
                         POWER_DSM_DIRECT_CHARGE_SC_FAULT_TDIE_OTP,
                         buf);
}
```

### 5.3 电池认证失败

**场景：** 电池 ROM ID 认证失败

```c
void battery_auth_check(void)
{
    int ret = battery_rom_id_authenticate();
    
    if (ret < 0) {
        char buf[512];
        
        snprintf(buf, sizeof(buf),
                 "Battery ROM ID Authentication Failed\n"
                 "Error Code: %d\n"
                 "Battery SN: %s\n"
                 "Expected CRC: 0x%08X\n"
                 "Actual CRC: 0x%08X\n"
                 "Board ID: %s\n"
                 "Build Number: %s\n",
                 ret,
                 get_battery_sn(),
                 get_expected_crc(),
                 get_actual_crc(),
                 get_board_id(),
                 get_build_number());
        
        power_dsm_report_dmd(POWER_DSM_BATTERY_DETECT,
                             POWER_DSM_BATTERY_ROM_ID_CERTIFICATION_FAIL,
                             buf);
    }
}
```

### 5.4 双电池异常检测

**场景：** 检测到双电池电流偏差过大

```c
void dual_battery_monitor(void)
{
    int ibat_main = get_main_battery_current();
    int ibat_aux = get_aux_battery_current();
    int diff = abs(ibat_main - ibat_aux);
    int ratio = (diff * 100) / max(ibat_main, ibat_aux);
    
    // 电流差异超过 20%
    if (ratio > 20) {
        char buf[512];
        
        snprintf(buf, sizeof(buf),
                 "Dual Battery Current Bias Detected\n"
                 "Main Battery:\n"
                 "  - Current: %d mA\n"
                 "  - Voltage: %d mV\n"
                 "  - SOC: %d%%\n"
                 "  - Temp: %d C\n"
                 "Aux Battery:\n"
                 "  - Current: %d mA\n"
                 "  - Voltage: %d mV\n"
                 "  - SOC: %d%%\n"
                 "  - Temp: %d C\n"
                 "Current Difference: %d mA (%d%%)\n"
                 "Charge Mode: %s\n",
                 ibat_main,
                 get_main_battery_voltage(),
                 get_main_battery_soc(),
                 get_main_battery_temp() / 10,
                 ibat_aux,
                 get_aux_battery_voltage(),
                 get_aux_battery_soc(),
                 get_aux_battery_temp() / 10,
                 diff,
                 ratio,
                 get_charge_mode_string());
        
        power_dsm_report_dmd(POWER_DSM_BATTERY,
                             POWER_DSM_DUAL_BATTERY_CURRENT_BIAS_DETECT,
                             buf);
    }
}
```

---

## 6. 调试接口

### 6.1 Sysfs 节点

**路径：** `/sys/class/hw_power/power_dsm/info`

**功能：** 手动触发 DSM 上报（调试用）

**写入格式：** `<type> <error_no> <message>`

**使用示例：**
```bash
# 手动上报电池温度过低异常
echo "3 34 Battery temp too low: -5C" > /sys/class/hw_power/power_dsm/info

# 查看最后一次上报的信息
cat /sys/class/hw_power/power_dsm/info
# 输出: type:3, err_no:34
```

### 6.2 日志分析

**关键日志标签：** `power_dsm`

**典型日志输出：**
```bash
# DSM 客户端注册
[power_dsm] dsm_battery dsm register ok
[power_dsm] dsm_charge_monitor dsm register ok
[power_dsm] dsm_direct_charge_sc dsm register ok

# DSM 上报
[power_dsm] report type:3, err_no:34
[power_dsm] type=3

# 上报失败（客户端忙）
[power_dsm] power dsm client is busy
```

### 6.3 DSM 上报统计

```bash
# 查看各模块的 DSM 上报次数
dmesg | grep "power_dsm" | grep "report type" | \
    awk '{print $5}' | sort | uniq -c | sort -rn

# 示例输出：
#  15 type:3,      # 电池异常上报 15 次
#   8 type:14,     # 直充异常上报 8 次
#   3 type:4,      # 充电监控上报 3 次
```

---

## 7. DSM 数据流

### 7.1 完整上报链路

```
内核模块检测异常
    ↓
调用 power_dsm_report_dmd()
    ↓
dsm_client_record() - 记录错误信息到缓冲区
    ↓
dsm_client_notify() - 通知 DSM 框架
    ↓
DSM 内核框架处理
    ↓
上报到用户空间 DSM Daemon
    ↓
DSM Daemon 采集上下文信息
    ├─ 系统日志（logcat/dmesg）
    ├─ 电池信息（/sys/class/power_supply/）
    ├─ 充电器信息
    └─ 温度信息
    ↓
封装成 DSM 报告
    ↓
上传到华为云端 DSM 服务器
    ↓
大数据分析平台
    ├─ 问题分类
    ├─ 频次统计
    ├─ 机型分布
    └─ 固件版本关联
    ↓
研发团队查看报告
    ├─ 问题定位
    ├─ 根因分析
    └─ 固件优化
```

### 7.2 缓冲区管理

**非阻塞机制：** `dsm_client_ocuppy()` 检查客户端是否空闲

```c
if (!dsm_client_ocuppy(client)) {
    // 客户端空闲，可以上报
    dsm_client_record(client, "%s", buf);
    dsm_client_notify(client, err_no);
} else {
    // 客户端忙（上次上报尚未完成），丢弃本次上报
    hwlog_err("power dsm client is busy\n");
}
```

**优点：**
- 避免阻塞内核线程
- 防止缓冲区溢出

**注意事项：**
- 高频异常可能导致部分上报丢失
- 需要合理控制上报频率

---

## 8. 设计要点总结

### 8.1 核心优势

| 优势 | 说明 | 价值 |
|-----|------|------|
| **问题可追溯** | 云端永久保存异常记录 | 历史问题可回溯分析 |
| **大数据分析** | 海量设备数据汇总 | 发现共性问题和规律 |
| **主动预警** | 异常频次超阈值自动告警 | 及时发现批量问题 |
| **用户无感** | 后台自动上报 | 不影响用户体验 |
| **信息丰富** | 记录完整上下文 | 便于问题定位 |

### 8.2 使用建议

**1. 合理选择错误码**
```c
// 好的做法：错误码精确
power_dsm_report_dmd(POWER_DSM_DIRECT_CHARGE_SC,
                     POWER_DSM_DIRECT_CHARGE_SC_FAULT_TDIE_OTP,  // 精确到芯片过温
                     buf);

// 不好的做法：错误码笼统
power_dsm_report_dmd(POWER_DSM_DIRECT_CHARGE_SC,
                     POWER_DSM_ERROR_WIRELESS_ERROR,  // 过于笼统
                     buf);
```

**2. 信息记录要全面**
```c
// 好的做法：记录关键上下文
snprintf(buf, size,
         "Error: %s\n"
         "Timestamp: %lld\n"
         "Battery: SOC=%d%%, Temp=%dC, Voltage=%dmV\n"
         "Charger: Type=%s, Current=%dmA\n"
         "IC Status: Reg0x01=0x%02X, Reg0x02=0x%02X\n",
         error_msg, timestamp,
         soc, temp, voltage,
         charger_type, current,
         reg01, reg02);

// 不好的做法：信息过少
snprintf(buf, size, "Error occurred\n");
```

**3. 控制上报频率**
```c
// 避免同一问题重复上报
static bool reported_temp_low = false;

if (temp < -10 && !reported_temp_low) {
    power_dsm_report_dmd(...);
    reported_temp_low = true;
}

// 温度恢复后重置标志
if (temp > 0) {
    reported_temp_low = false;
}
```

**4. 使用 dump 机制处理批量数据**
```c
// 适合周期性监控的场景
static struct power_dsm_dump monitor_table[] = {
    {
        .type = POWER_DSM_CHARGE_MONITOR,
        .error_no = POWER_DSM_ERROR_WEAKSOURCE_STOP_CHARGE,
        .dump_enable = true,
        .dump_always = true,  // 每次都检查
        .check_error = check_weak_source,
        .dump = dump_charge_info,
    },
};

// 定时任务调用
void charge_monitor_timer(void)
{
    power_dsm_dump_data(monitor_table, ARRAY_SIZE(monitor_table));
}
```

### 8.3 注意事项

1. **DSM 客户端忙时会丢弃上报**：高频异常需要去重
2. **缓冲区大小有限**：避免记录过长字符串
3. **非实时系统**：DSM 用于离线分析，不适合实时告警
4. **用户隐私**：不要上报敏感信息（SN号可上报，但需脱敏处理）
