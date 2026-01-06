---
outline: deep
---
# 华为充电管理之HVDCP Charge充电模式

## 1. 模块概述

### 1.1 模块定位
HVDCP (High Voltage DCP) Charge 是华为充电系统中的**高压 DCP 充电管理模块**，主要负责基于 FCP 协议的快速充电控制。该模块提供高于标准 5V 的充电电压（通常为 9V/12V），以提高充电功率和充电速度。

**核心功能：**
- HVDCP 适配器检测与识别
- 高压充电握手协议处理
- 充电阶段状态管理
- 适配器电压调节与复位
- 异常检测与错误上报

**文件位置：**
```
drivers/hwpower/cc_charger/hvdcp_charge/
├── hvdcp_charge.c          # HVDCP 充电核心实现
├── hvdcp_charge.h          # HVDCP 接口定义
└── Makefile                # 编译配置
```

### 1.2 设计特点

**充电策略：**
- 优先级兼容：在直充（Direct Charge）不支持或失败时启用 HVDCP
- 阶段化管理：通过多个阶段（STAGE）控制充电握手流程
- 重试机制：适配器检测、使能失败时自动重试
- 安全保护：实时监测适配器和主控状态，异常时复位

**系统集成：**
- 与 Adapter Detect 模块协同完成适配器类型识别
- 通过 FCP 协议与适配器通信
- 与 Direct Charge 模块互斥，避免冲突
- 通过 DSM 上报充电异常

---

## 2. 核心数据结构

### 2.1 全局状态变量

```c
/* 充电使能标志 */
static bool g_hvdcp_charging_flag;

/* 当前充电阶段 */
static unsigned int g_hvdcp_charging_stage = HVDCP_STAGE_DEFAUTL;

/* 主控错误计数 */
static unsigned int g_hvdcp_master_error_cnt;

/* Vboost 重试计数 */
static unsigned int g_hvdcp_vboost_retry_cnt;

/* 适配器重试计数 */
static unsigned int g_hvdcp_adapter_retry_cnt;

/* 适配器使能计数 */
static unsigned int g_hvdcp_adapter_enable_cnt;

/* 适配器检测计数 */
static unsigned int g_hvdcp_adapter_detect_cnt;
```

### 2.2 充电阶段枚举

```c
enum hvdcp_stage_type {
    HVDCP_STAGE_DEFAUTL,          // 默认阶段
    HVDCP_STAGE_SUPPORT_DETECT,   // 支持性检测阶段
    HVDCP_STAGE_ADAPTER_DETECT,   // 适配器检测阶段
    HVDCP_STAGE_ADAPTER_ENABLE,   // 适配器使能阶段
    HVDCP_STAGE_SUCCESS,          // 充电成功阶段
    HVDCP_STAGE_CHARGE_DONE,      // 充电完成阶段
    HVDCP_STAGE_RESET_ADAPTER,    // 复位适配器阶段
    HVDCP_STAGE_ERROR,            // 错误阶段
};
```

**阶段说明：**
- `DEFAUTL`：初始状态或未充电状态
- `SUPPORT_DETECT`：检测是否支持 HVDCP
- `ADAPTER_DETECT`：通过 FCP 协议检测适配器能力
- `ADAPTER_ENABLE`：使能适配器输出高压（9V/12V）
- `SUCCESS`：HVDCP 充电成功建立
- `CHARGE_DONE`：充电完成（电池满电）
- `RESET_ADAPTER`：需要复位适配器
- `ERROR`：充电异常状态

### 2.3 复位类型枚举

```c
enum hvdcp_reset_type {
    HVDCP_RESET_ADAPTER,   // 复位适配器（Slave端）
    HVDCP_RESET_MASTER,    // 复位主控（Master端）
};
```

### 2.4 关键常量定义

```c
/* 重试次数限制 */
#define HVDCP_MAX_MASTER_ERROR_CNT   4    // 主控最大错误次数
#define HVDCP_MAX_VBOOST_RETRY_CNT   2    // Vboost 最大重试次数
#define HVDCP_MAX_ADAPTER_RETRY_CNT  3    // 适配器最大重试次数
#define HVDCP_MAX_ADAPTER_ENABLE_CNT 4    // 适配器使能最大重试次数
#define HVDCP_MAX_ADAPTER_DETECT_CNT 4    // 适配器检测最大重试次数

/* 电压范围 */
#define HVDCP_RESET_VOLT_LOWER_LIMIT 4500 // 复位后最低电压 (mV)
#define HVDCP_RESET_VOLT_UPPER_LIMIT 5500 // 复位后最高电压 (mV)

/* 充电器配置 */
#define HVDCP_MIVR_SETTING           4600000 // MIVR 电压设置 (uV)
```

---

## 3. 核心功能实现

### 3.1 适配器检测

#### 3.1.1 检测流程（非 Direct Charge 场景）

```c
#ifndef CONFIG_DIRECT_CHARGER
int hvdcp_detect_adapter(void)
{
    int ret;
    int adp_mode = ADAPTER_SUPPORT_UNDEFINED;

    /* 通过 FCP 协议 PING 检测适配器类型 */
    ret = adapter_detect_ping_fcp_type(&adp_mode);
    hwlog_info("detect_adapter: adp_mode=%x ret=%d\n", adp_mode, ret);

    if (ret == ADAPTER_DETECT_FAIL) {
        hwlog_err("detect adapter fail\n");
        return ADAPTER_DETECT_FAIL;
    }

    if (ret == ADAPTER_DETECT_OTHER) {
        hwlog_err("detect adapter other\n");
        return ADAPTER_DETECT_OTHER;
    }

    return ADAPTER_DETECT_SUCC;
}
#endif
```

#### 3.1.2 检测流程（Direct Charge 场景）

```c
#ifdef CONFIG_DIRECT_CHARGER
int hvdcp_detect_adapter(void)
{
    int ret;
    int adp_mode = ADAPTER_SUPPORT_UNDEFINED;
    int dc_adp_mode = ADAPTER_SUPPORT_UNDEFINED;
    unsigned int cnt;

    /* 通过 FCP 协议检测适配器 */
    ret = adapter_detect_ping_fcp_type(&adp_mode);
    hwlog_info("detect_adapter: adp_mode=%x ret=%d\n", adp_mode, ret);

    /* 如果直充未失败，优先使用直充 */
    if (!direct_charge_is_failed()) {
        hvdcp_set_vboost_retry_count(0);

        if (ret == ADAPTER_DETECT_FAIL)
            return ADAPTER_DETECT_FAIL;

        if (ret == ADAPTER_DETECT_OTHER)
            return ADAPTER_DETECT_OTHER;

        /* 检查是否支持直充协议（LVC/SC） */
        (void)adapter_get_support_mode(ADAPTER_PROTOCOL_SCP, &dc_adp_mode);
        hwlog_info("detect_adapter: dc_adp_mode=%x\n", dc_adp_mode);
        
        /* 优先使用直充协议 */
        if ((dc_adp_mode & ADAPTER_SUPPORT_LVC) || 
            (dc_adp_mode & ADAPTER_SUPPORT_SC))
            return ADAPTER_DETECT_OTHER;
    }

    /* Vboost 重试机制 */
    cnt = hvdcp_get_vboost_retry_count();
    hwlog_info("vboost_retry cnt=%u, max_cnt=%d\n", cnt, HVDCP_MAX_VBOOST_RETRY_CNT);
    
    if (cnt >= HVDCP_MAX_VBOOST_RETRY_CNT)
        return ADAPTER_DETECT_OTHER;
    
    hvdcp_set_vboost_retry_count(++cnt);

    /* 非工厂模式下，必须支持 HV 才能使用 HVDCP */
    if (!power_cmdline_is_factory_mode() && 
        (ret || (adp_mode != ADAPTER_SUPPORT_HV)))
        return ADAPTER_DETECT_OTHER;
        
    return ADAPTER_DETECT_SUCC;
}
#endif
```

**检测逻辑：**
1. 通过 FCP PING 协议检测适配器
2. 如果开启直充，优先检查是否支持 LVC/SC 直充协议
3. 实施 Vboost 重试机制（最多 2 次）
4. 验证是否支持高压（ADAPTER_SUPPORT_HV）

### 3.2 适配器电压控制

#### 3.2.1 设置电压

```c
int hvdcp_set_adapter_voltage(int volt)
{
    /* 调用 FCP 协议设置适配器输出电压 */
    int ret = adapter_set_output_voltage(ADAPTER_PROTOCOL_FCP, volt);
    
    hwlog_info("set_adapter_voltage: volt=%d ret=%d\n", volt, ret);
    return ret;
}
```

#### 3.2.2 降压到 5V

```c
int hvdcp_decrease_adapter_voltage_to_5v(void)
{
    int i;
    int ret;
    int vbus = 0;
    int adp_type = ADAPTER_TYPE_UNKNOWN;

    /* 获取适配器类型 */
    adapter_get_adp_type(ADAPTER_PROTOCOL_SCP, &adp_type);
    hwlog_info("adp_type=%d\n", adp_type);

    /* 65W 适配器不支持复位，需主动设置电压为 5V */
    if ((adp_type == ADAPTER_TYPE_20V3P25A_MAX) ||
        (adp_type == ADAPTER_TYPE_20V3P25A)) {
        
        /* 设置输出电压为 5V */
        ret = hvdcp_set_adapter_voltage(ADAPTER_5V * POWER_MV_PER_V);
        if (ret)
            goto reset_adapter;

        /* 等待电压降低，延迟 1 秒 */
        for (i = 0; i < (DT_MSLEEP_1S / DT_MSLEEP_50MS); i++)
            (void)power_msleep(DT_MSLEEP_50MS, 0, NULL);

        /* 验证 Vbus 是否在 4.5V-5.5V 范围内 */
        charge_get_vbus(&vbus);
        if ((vbus > HVDCP_RESET_VOLT_UPPER_LIMIT) ||
            (vbus < HVDCP_RESET_VOLT_LOWER_LIMIT)) {
            hwlog_info("adapter vbus=%d out of range\n", vbus);
            goto reset_adapter;
        }

        return 0;
    }

reset_adapter:
    /* 其他适配器通过软复位降压 */
    return hvdcp_reset_adapter();
}
```

**降压策略：**
- **65W 适配器**：通过协议设置电压为 5V，等待 1 秒，验证电压范围
- **其他适配器**：通过软复位（RESET）降压
- **电压验证**：Vbus 需在 4.5V-5.5V 范围内

### 3.3 复位操作

#### 3.3.1 复位适配器（Slave 端）

```c
int hvdcp_reset_adapter(void)
{
    return adapter_soft_reset_slave(ADAPTER_PROTOCOL_FCP);
}
```

#### 3.3.2 复位主控（Master 端）

```c
int hvdcp_reset_master(void)
{
    return adapter_soft_reset_master(ADAPTER_PROTOCOL_FCP);
}
```

#### 3.3.3 复位操作统一接口

```c
int hvdcp_reset_operate(unsigned int type)
{
    int ret;
    unsigned int chg_state = CHAGRE_STATE_NORMAL;

    /* 检查充电器是否在位（Power Good） */
    charge_get_charging_state(&chg_state);
    if (chg_state & CHAGRE_STATE_NOT_PG) {
        hwlog_err("charger not power good, no need reset\n");
        return -EINVAL;
    }

    hwlog_info("reset_operate: type=%u\n", type);
    
    switch (type) {
    case HVDCP_RESET_ADAPTER:
        /* 复位适配器 */
        ret = hvdcp_reset_adapter();
        break;
        
    case HVDCP_RESET_MASTER:
        /* 复位主控，需延迟 2 秒等待复位完成 */
        ret = hvdcp_reset_master();
        (void)power_msleep(DT_MSLEEP_2S, 0, NULL);
        break;
        
    default:
        ret = -EINVAL;
        break;
    }

    return ret;
}
```

### 3.4 状态检测与保护

#### 3.4.1 适配器状态检测

```c
void hvdcp_check_adapter_status(void)
{
    int status;
    unsigned int dmd_no;
    char buf[POWER_DSM_BUF_SIZE_0128] = { 0 };
    unsigned int chg_state = CHAGRE_STATE_NORMAL;

    /* 检查充电器是否在位 */
    charge_get_charging_state(&chg_state);
    if (chg_state & CHAGRE_STATE_NOT_PG) {
        hwlog_info("charger not power good, no need check adapter status\n");
        return;
    }

    /* 获取适配器状态（UVP/OCP/OTP） */
    status = adapter_get_slave_status(ADAPTER_PROTOCOL_FCP);
    hwlog_info("check_adapter_status: status=%d\n", status);
    
    switch (status) {
    case ADAPTER_OUTPUT_UVP:  /* 欠压保护 */
        dmd_no = POWER_DSM_ERROR_ADAPTER_OVLT;
        snprintf(buf, sizeof(buf), "hvdcp adapter voltage over high\n");
        break;
        
    case ADAPTER_OUTPUT_OCP:  /* 过流保护 */
        dmd_no = POWER_DSM_ERROR_ADAPTER_OCCURRENT;
        snprintf(buf, sizeof(buf), "hvdcp adapter current over high\n");
        break;
        
    case ADAPTER_OUTPUT_OTP:  /* 过温保护 */
        dmd_no = POWER_DSM_ERROR_ADAPTER_OTEMP;
        snprintf(buf, sizeof(buf), "hvdcp adapter temp over high\n");
        break;
        
    default:
        return;
    }

    hwlog_info("%s\n", buf);
    /* 上报 DSM 异常 */
    power_dsm_report_dmd(POWER_DSM_FCP_CHARGE, dmd_no, buf);
}
```

#### 3.4.2 主控状态检测

```c
void hvdcp_check_master_status(void)
{
    int status;
    char buf[POWER_DSM_BUF_SIZE_0128] = { 0 };
    unsigned int chg_state = CHAGRE_STATE_NORMAL;

    /* 检查充电器是否在位 */
    charge_get_charging_state(&chg_state);
    if (chg_state & CHAGRE_STATE_NOT_PG) {
        hwlog_info("charger not power good, no need check master status\n");
        return;
    }

    /* 获取主控状态 */
    status = adapter_get_master_status(ADAPTER_PROTOCOL_FCP);
    
    /* 错误计数累加 */
    if (status)
        g_hvdcp_master_error_cnt++;
    else
        g_hvdcp_master_error_cnt = 0;

    hwlog_info("check_master_status: status=%d error_cnt=%u\n",
        status, g_hvdcp_master_error_cnt);

    /* 达到最大错误次数，上报 DSM */
    if (g_hvdcp_master_error_cnt >= HVDCP_MAX_MASTER_ERROR_CNT) {
        g_hvdcp_master_error_cnt = 0;
        snprintf(buf, sizeof(buf), "hvdcp adapter connect fail\n");
        hwlog_info("%s\n", buf);
        power_dsm_report_dmd(POWER_DSM_FCP_CHARGE, 
            POWER_DSM_ERROR_SWITCH_ATTACH, buf);
    }
}
```

### 3.5 充电退出处理

```c
bool hvdcp_exit_charging(void)
{
    hwlog_info("exit_charging\n");

    /* 步骤1：设置 MIVR 为 4.6V */
    (void)charge_set_mivr(HVDCP_MIVR_SETTING);

    /* 步骤2：设置适配器输出电压为 5V */
    if (hvdcp_decrease_adapter_voltage_to_5v())
        return false;

    /* 步骤3：设置充电器输入电压为 5V */
    (void)charge_set_vbus_vset(ADAPTER_5V);
    
    return true;
}
```

**退出流程：**
1. 设置 MIVR（Minimum Input Voltage Regulation）为 4.6V
2. 将适配器电压降低到 5V
3. 配置充电器输入电压为 5V

### 3.6 重试机制

#### 3.6.1 适配器使能重试计数

```c
bool hvdcp_check_adapter_enable_count(void)
{
    int vbus = 0;
    char buf[POWER_DSM_BUF_SIZE_0128] = { 0 };
    unsigned int cnt = hvdcp_get_adapter_enable_count();

    /* 如果处于使能阶段，计数递增 */
    if (hvdcp_get_charging_stage() == HVDCP_STAGE_ADAPTER_ENABLE)
        ++cnt;
    else
        cnt = 0;

    hvdcp_set_adapter_enable_count(cnt);
    hwlog_info("adapter_enable cnt=%u, max_cnt=%d\n", 
        cnt, HVDCP_MAX_ADAPTER_ENABLE_CNT);

    /* 达到最大重试次数，上报 DSM */
    if (cnt >= HVDCP_MAX_ADAPTER_ENABLE_CNT) {
        charge_get_vbus(&vbus);
        snprintf(buf, sizeof(buf), "hvdcp enable fail, vbus=%d\n", vbus);
        hwlog_info("%s\n", buf);
        
#ifdef CONFIG_DIRECT_CHARGER
        if (!direct_charge_is_failed())
            power_dsm_report_dmd(POWER_DSM_FCP_CHARGE, 
                POWER_DSM_ERROR_FCP_OUTPUT, buf);
#else
        power_dsm_report_dmd(POWER_DSM_FCP_CHARGE, 
            POWER_DSM_ERROR_FCP_OUTPUT, buf);
#endif
    }

    return (cnt < HVDCP_MAX_ADAPTER_ENABLE_CNT) ? true : false;
}
```

#### 3.6.2 适配器检测重试计数

```c
bool hvdcp_check_adapter_detect_count(void)
{
    int vbus = 0;
    char buf[POWER_DSM_BUF_SIZE_0128] = { 0 };
    unsigned int cnt = hvdcp_get_adapter_detect_count();

    /* 如果处于检测阶段，计数递增 */
    if (hvdcp_get_charging_stage() == HVDCP_STAGE_ADAPTER_DETECT)
        ++cnt;
    else
        cnt = 0;

    hvdcp_set_adapter_detect_count(cnt);
    hwlog_info("adapter_detect cnt=%u, max_cnt=%d\n", 
        cnt, HVDCP_MAX_ADAPTER_DETECT_CNT);

    /* 达到最大重试次数，上报 DSM */
    if (cnt >= HVDCP_MAX_ADAPTER_DETECT_CNT) {
        charge_get_vbus(&vbus);
        snprintf(buf, sizeof(buf), "hvdcp detect fail, vbus=%d\n", vbus);
        hwlog_info("%s\n", buf);
        power_dsm_report_dmd(POWER_DSM_FCP_CHARGE, 
            POWER_DSM_ERROR_FCP_DETECT, buf);
    }

    return (cnt < HVDCP_MAX_ADAPTER_DETECT_CNT) ? true : false;
}
```

---

## 4. 典型使用场景

### 4.1 HVDCP 充电启动流程

```
1. 插入充电器
   ↓
2. 检测充电器类型（hvdcp_check_charger_type）
   - 仅支持 CHARGER_TYPE_STANDARD 和 CHARGER_TYPE_FCP
   ↓
3. 进入支持性检测阶段（HVDCP_STAGE_SUPPORT_DETECT）
   ↓
4. 适配器检测阶段（HVDCP_STAGE_ADAPTER_DETECT）
   - 调用 hvdcp_detect_adapter()
   - 检测是否优先使用 Direct Charge
   - FCP PING 检测适配器能力
   ↓
5. 适配器使能阶段（HVDCP_STAGE_ADAPTER_ENABLE）
   - 设置适配器输出电压（9V/12V）
   - 验证 Vbus 电压
   ↓
6. 充电成功（HVDCP_STAGE_SUCCESS）
   - 开始高压充电
   ↓
7. 充电完成（HVDCP_STAGE_CHARGE_DONE）
```

### 4.2 与 Direct Charge 协同

```c
/* HVDCP 模块会检查 Direct Charge 是否失败 */
if (!direct_charge_is_failed()) {
    /* 直充未失败，优先使用直充 */
    if ((dc_adp_mode & ADAPTER_SUPPORT_LVC) || 
        (dc_adp_mode & ADAPTER_SUPPORT_SC))
        return ADAPTER_DETECT_OTHER;  // 不启用 HVDCP
}

/* Direct Charge 失败或不支持时，才使用 HVDCP */
```

**优先级：**
1. 直充（LVC/SC） - 最高优先级
2. HVDCP (9V/12V)
3. 标准充电 (5V)

### 4.3 65W 适配器特殊处理

```c
/* 65W 适配器（20V/3.25A）不支持复位，需主动降压 */
if ((adp_type == ADAPTER_TYPE_20V3P25A_MAX) ||
    (adp_type == ADAPTER_TYPE_20V3P25A)) {
    
    /* 设置电压为 5V */
    hvdcp_set_adapter_voltage(ADAPTER_5V * POWER_MV_PER_V);
    
    /* 等待电压稳定 */
    power_msleep(DT_MSLEEP_1S, 0, NULL);
    
    /* 验证电压范围 (4.5V-5.5V) */
    charge_get_vbus(&vbus);
    if (vbus < 4500 || vbus > 5500)
        goto reset_adapter;  // 降压失败，强制复位
}
```

---

## 5. 调试方法

### 5.1 日志分析

**关键日志标签：** `hvdcp_charge`

**典型日志输出：**
```bash
# 阶段切换
[hvdcp_charge] set_charging_stage: stage=2  # 进入 ADAPTER_DETECT 阶段

# 适配器检测
[hvdcp_charge] detect_adapter: adp_mode=0x4 ret=0
[hvdcp_charge] detect_adapter: dc_adp_mode=0x10 ret=0

# 电压设置
[hvdcp_charge] set_adapter_voltage: volt=9000 ret=0

# 重试计数
[hvdcp_charge] adapter_enable cnt=1, max_cnt=4
[hvdcp_charge] vboost_retry cnt=1, max_cnt=2

# 状态检测
[hvdcp_charge] check_adapter_status: status=0
[hvdcp_charge] check_master_status: status=0 error_cnt=0
```

### 5.2 常见问题诊断

#### 问题1：适配器检测失败
```bash
# 日志特征
[hvdcp_charge] detect adapter fail
[hvdcp_charge] adapter_detect cnt=4, max_cnt=4
[hvdcp_charge] hvdcp detect fail, vbus=5000

# 原因分析
1. 适配器不支持 FCP 协议
2. USB 线缆不支持快充（无 D+/D- 数据线）
3. 主控 FCP 通信异常

# 解决方法
- 检查适配器是否为华为原装快充
- 更换支持快充的 USB 线缆
- 检查主控 FCP 协议栈是否正常初始化
```

#### 问题2：适配器使能失败
```bash
# 日志特征
[hvdcp_charge] adapter_enable cnt=4, max_cnt=4
[hvdcp_charge] hvdcp enable fail, vbus=5200

# 原因分析
1. 适配器升压失败
2. Vbus 电压异常
3. 充电器 IC 不支持高压输入

# 解决方法
- 检查适配器输出能力
- 验证充电器 IC 的 MIVR 配置
- 查看充电器 IC 是否有输入过压保护
```

#### 问题3：主控通信异常
```bash
# 日志特征
[hvdcp_charge] check_master_status: status=1 error_cnt=4
[hvdcp_charge] hvdcp adapter connect fail

# 原因分析
1. FCP 通信时序异常
2. D+/D- 线路干扰
3. 主控 FCP 模块故障

# 解决方法
- 检查 FCP 协议栈时序参数
- 检查硬件 D+/D- 线路
- 复位主控 FCP 模块
```

### 5.3 DSM 错误代码

| DSM 错误码 | 含义 | 触发条件 |
|-----------|------|---------|
| `POWER_DSM_ERROR_ADAPTER_OVLT` | 适配器电压异常 | 适配器状态返回 UVP |
| `POWER_DSM_ERROR_ADAPTER_OCCURRENT` | 适配器过流 | 适配器状态返回 OCP |
| `POWER_DSM_ERROR_ADAPTER_OTEMP` | 适配器过温 | 适配器状态返回 OTP |
| `POWER_DSM_ERROR_SWITCH_ATTACH` | 适配器连接失败 | 主控错误次数超过 4 次 |
| `POWER_DSM_ERROR_FCP_OUTPUT` | FCP 输出异常 | 适配器使能失败超过 4 次 |
| `POWER_DSM_ERROR_FCP_DETECT` | FCP 检测失败 | 适配器检测失败超过 4 次 |

### 5.4 调试命令

```bash
# 1. 查看充电状态
cat /sys/class/power_supply/battery/status

# 2. 查看 Vbus 电压
cat /sys/class/power_supply/usb/voltage_now

# 3. 查看充电电流
cat /sys/class/power_supply/battery/current_now

# 4. 查看充电器类型
cat /sys/class/power_supply/usb/type

# 5. 查看 dmesg 日志
dmesg | grep hvdcp_charge

# 6. 实时监控日志
logcat -s hvdcp_charge
```

---

## 6. 关键技术要点

### 6.1 FCP 协议交互

HVDCP 模块基于 **FCP (Fast Charge Protocol)** 协议与适配器通信：

```
主控                          适配器
  |                              |
  |---- FCP PING -------------->|  # 检测适配器
  |<--- ACK + 能力信息 ---------|  # 返回支持的模式
  |                              |
  |---- 设置输出电压 9V -------->|  # 使能高压
  |<--- ACK -------------------|  # 确认设置成功
  |                              |
  |---- 查询状态 -------------->|  # 定期查询
  |<--- 状态信息（UVP/OCP/OTP）-|  # 返回保护状态
```

### 6.2 重试策略

| 重试类型 | 最大次数 | 计数条件 | DSM 上报条件 |
|---------|---------|---------|-------------|
| Vboost 重试 | 2 | 每次检测失败 | 不上报 |
| 适配器重试 | 3 | 通用重试 | 不上报 |
| 适配器检测 | 4 | ADAPTER_DETECT 阶段 | 达到最大次数时上报 |
| 适配器使能 | 4 | ADAPTER_ENABLE 阶段 | 达到最大次数时上报 |
| 主控错误 | 4 | 每次状态查询失败 | 达到最大次数时上报 |

### 6.3 安全保护机制

**1. 充电器在位检测**
```c
charge_get_charging_state(&chg_state);
if (chg_state & CHAGRE_STATE_NOT_PG) {
    /* 充电器不在位，停止操作 */
    return;
}
```

**2. 适配器状态监测**
- UVP（Under Voltage Protection）：欠压保护
- OCP（Over Current Protection）：过流保护
- OTP（Over Temperature Protection）：过温保护

**3. 电压范围验证**
```c
/* 复位后验证 Vbus 在 4.5V-5.5V 范围内 */
if ((vbus > HVDCP_RESET_VOLT_UPPER_LIMIT) ||
    (vbus < HVDCP_RESET_VOLT_LOWER_LIMIT)) {
    /* 电压异常，强制复位 */
    goto reset_adapter;
}
```

### 6.4 与其他模块的交互

```
hvdcp_charge 模块依赖：
├── adapter_detect         # 适配器类型检测
├── adapter_protocol       # FCP 协议栈
├── charger_common         # 充电器通用接口
├── direct_charger         # 直充模块（互斥判断）
└── power_dsm              # 异常上报

对外提供接口：
├── hvdcp_get_charging_flag()       # 获取充电标志
├── hvdcp_set_charging_stage()      # 设置充电阶段
├── hvdcp_detect_adapter()          # 适配器检测
├── hvdcp_set_adapter_voltage()     # 设置适配器电压
├── hvdcp_reset_operate()           # 复位操作
├── hvdcp_check_adapter_status()    # 检查适配器状态
└── hvdcp_exit_charging()           # 退出充电
```

---

## 7. 总结

### 7.1 模块特点

1. **简洁高效**：代码量少（约 460 行），功能单一明确
2. **协议兼容**：基于 FCP 协议，与华为快充生态兼容
3. **优先级控制**：与 Direct Charge 协同，避免冲突
4. **安全可靠**：多重保护机制（UVP/OCP/OTP）和重试策略
5. **易于调试**：完善的日志输出和 DSM 异常上报

### 7.2 适用场景

- **适配器**：华为 FCP 快充适配器（9V/12V）
- **充电功率**：10W-18W（9V/2A 或 12V/1.5A）
- **降级场景**：直充不支持或失败时的备用方案
- **特殊适配器**：65W 适配器（20V/3.25A）的降压处理

### 7.3 注意事项

1. **优先级**：HVDCP 优先级低于 Direct Charge（LVC/SC）
2. **协议依赖**：必须有完整的 FCP 协议栈支持
3. **线缆要求**：需使用支持 D+/D- 数据通信的 USB 线缆
4. **充电器兼容性**：充电器 IC 必须支持高于 5V 的输入电压
5. **退出流程**：退出时需按顺序降压（MIVR → 适配器 → 充电器）
