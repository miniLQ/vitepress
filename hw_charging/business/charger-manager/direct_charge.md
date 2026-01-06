---
outline: deep
---
# 华为充电管理之direct_charge 充电模式

## 模块概述

`direct_charge` 是华为充电管理子系统中的**直充（Direct Charge）核心模块**，负责管理**高压直充技术**，包括 **LVC（Linear Voltage Converter）、SC（Switch Capacitor）、SC4（4:1 Switch Capacitor）**等多种直充模式。该模块通过绕过传统 Buck 充电芯片，直接将适配器高压电流转换到电池，实现高功率快速充电。

**核心功能：**
- **多模式直充支持：** LVC（1:1）、SC（2:1）、SC4（4:1）三种转换模式
- **多阶段充电管理：** 适配器检测 → 路径切换 → 安全检查 → CC/CV 充电 → 充电完成
- **智能功率分配：** 根据电池温度、电压、电流动态调整充电参数
- **多 IC 协同：** 支持单 IC/双 IC 并联，智能负载均衡
- **安全保护机制：** 过压、过流、过温、短路、反接等多重保护
- **适配器协商：** 支持 PD、SCP、FCP、UFCS 等多种快充协议
- **电缆检测：** 识别电缆电阻，确保充电安全
- **温度补偿：** JEITA 标准温度分级，动态调整充电策略

**架构图：**

```
┌──────────────────────────────────────────────────────┐
│              Direct Charge Framework                 │
│  ┌────────────────────────────────────────────────┐ │
│  │         Mode Management                        │ │
│  │  ┌──────┬──────┬──────┐                       │ │
│  │  │ LVC  │  SC  │ SC4  │  Mode Selection       │ │
│  │  │(1:1) │(2:1) │(4:1) │                       │ │
│  │  └──────┴──────┴──────┘                       │ │
│  └────────────────────────────────────────────────┘ │
│                                                      │
│  ┌────────────────────────────────────────────────┐ │
│  │         Charging Control                       │ │
│  │  ┌──────────────────────────────────────────┐ │ │
│  │  │ Stage Flow:                              │ │ │
│  │  │ 1. Adapter Detect                        │ │ │
│  │  │ 2. Path Switch (Buck → Direct)           │ │ │
│  │  │ 3. Security Check                        │ │ │
│  │  │ 4. Multi-Stage CC/CV Charging            │ │ │
│  │  │ 5. Charge Done                           │ │ │
│  │  └──────────────────────────────────────────┘ │ │
│  └────────────────────────────────────────────────┘ │
│                                                      │
│  ┌────────────────────────────────────────────────┐ │
│  │         IC Management                          │ │
│  │  ┌─────────┬─────────┐                        │ │
│  │  │ Main IC │  Aux IC │  Multi-IC Parallel     │ │
│  │  └─────────┴─────────┘                        │ │
│  └────────────────────────────────────────────────┘ │
└──────────────────────────────────────────────────────┘
               │
      ┌────────┴────────┐
      │                 │
┌─────▼─────┐     ┌────▼──────┐
│ Adapter   │     │  Battery  │
│ (PD/SCP/  │     │  Pack     │
│  FCP/UFCS)│     │           │
└───────────┘     └───────────┘
```

---

## 主要模块组成

### 1. 核心模块文件

| 文件 | 功能 |
|------|------|
| direct_charge_common.c | 公共基础功能（模式管理、标志位管理） |
| direct_charge_work.c | 工作队列管理（控制循环、阈值计算、看门狗） |
| direct_charge_control.c | 充电控制逻辑（CC/CV 调节、电压电流控制） |
| direct_charger_lvc.c | LVC 模式驱动（1:1 转换） |
| direct_charger_sc.c | SC 模式驱动（2:1 转换） |
| `direct_charger_sc4.c` | SC4 模式驱动（4:1 转换） |

### 2. 功能模块文件

| 文件 | 功能 |
|------|------|
| `direct_charge_adapter.c` | 适配器检测与协商 |
| `direct_charge_cable.c` | 电缆检测（电阻、温度） |
| `direct_charge_check.c` | 安全检查（电池、适配器、IC） |
| `direct_charge_para_parse.c` | DTS 参数解析 |
| `direct_charge_path_switch.c` | 充电路径切换（Buck ↔ Direct） |
| `direct_charge_device_id.c` | 设备 ID 管理 |
| `direct_charge_calibration.c` | 校准功能 |
| `direct_charge_charging_info.c` | 充电信息记录 |
| `direct_charge_vote.c` | 投票系统集成 |
| `direct_charge_pmode.c` | 功率模式管理 |
| `direct_charge_turbo.c` | Turbo 快充模式 |

### 3. 辅助模块文件

| 文件 | 功能 |
|------|------|
| `direct_charge_sysfs.c` | sysfs 节点接口 |
| `direct_charge_debug.c` | 调试功能 |
| `direct_charge_test.c` | 测试功能 |
| `direct_charge_uevent.c` | uevent 事件上报 |
| `direct_charge_power_supply.c` | Power Supply 接口 |

---

## 核心数据结构

### 1. 直充模式映射表

```c
static struct mode_info g_dc_map_tbl[] = {
    [LVC_MODE] = { DC_MODE_LVC, "lvc_mode", 1 },   // 1:1 转换
    [SC_MODE] = { DC_MODE_SC, "sc_mode", 2 },      // 2:1 转换
    [SC_MODE] = { DC_MODE_SC4, "sc4_mode", 4 },    // 4:1 转换
};
```

**模式说明：**

| 模式 | 转换比例 | 适配器电压 | 电池电压 | 典型功率 |
|------|---------|----------|---------|---------|
| LVC | 1:1 | 5-10V | 5-10V | ≤40W |
| SC | 2:1 | 8-20V | 4-10V | ≤100W |
| SC4 | 4:1 | 16-40V | 4-10V | ≤200W |

**示例：**
```
SC 模式（2:1）：
  适配器输出：10V @ 6A = 60W
  电池接收：5V @ 12A = 60W（忽略损耗）
```

### 2. 充电阶段状态机

```c
enum direct_charge_stage_type {
    DC_STAGE_DEFAULT,           // 默认状态
    DC_STAGE_ADAPTER_DETECT,    // 适配器检测
    DC_STAGE_SWITCH_DETECT,     // 路径切换检测
    DC_STAGE_CHARGE_INIT,       // 充电初始化
    DC_STAGE_SECURITY_CHECK,    // 安全检查
    DC_STAGE_SUCCESS,           // 检查成功
    DC_STAGE_CHARGING,          // 充电中
    DC_STAGE_CHARGE_DONE,       // 充电完成
};
```

**状态转换流程：**

```
DEFAULT
  ↓
ADAPTER_DETECT（检测适配器协议和能力）
  ↓
SWITCH_DETECT（检测路径切换 IC）
  ↓
CHARGE_INIT（初始化充电 IC）
  ↓
SECURITY_CHECK（安全检查：电池/电缆/温度）
  ↓
SUCCESS（检查通过）
  ↓
CHARGING（CC/CV 多阶段充电）
  ↓
CHARGE_DONE（充电完成）
```

### 3. 温度补偿参数

```c
struct direct_charge_temp_para {
    int temp_min;       // 温度下限（0.1°C）
    int temp_max;       // 温度上限（0.1°C）
    int temp_cur_max;   // 该温度段最大充电电流（mA）
};
```

**典型配置（5 级温度补偿）：**

| 温度区间 | temp_min | temp_max | temp_cur_max |
|---------|----------|----------|--------------|
| 极低温 | -200 | 100 | 1000mA |
| 低温 | 100 | 150 | 3000mA |
| 正常 | 150 | 450 | 6000mA |
| 高温 | 450 | 500 | 3000mA |
| 极高温 | 500 | 600 | 1000mA |

### 4. 多阶段 CC/CV 参数

```c
struct direct_charge_volt_para {
    int vol_th;         // 电压阈值（mV）
    int cur_th_high;    // 高电流阈值（mA）
    int cur_th_low;     // 低电流阈值（mA）
};
```

**典型配置（8 级 CC/CV）：**

| 阶段 | vol_th | cur_th_high | cur_th_low | 说明 |
|------|--------|-------------|------------|------|
| 0 | 3400 | 6000 | 5500 | 低压大电流 |
| 1 | 3700 | 6000 | 5500 | |
| 2 | 4000 | 5000 | 4500 | |
| 3 | 4200 | 5000 | 4500 | |
| 4 | 4350 | 4000 | 3500 | 中压中电流 |
| 5 | 4400 | 4000 | 3500 | |
| 6 | 4450 | 2000 | 1500 | 高压小电流 |
| 7 | 4480 | 1000 | 500 | 涓流充电 |

---

## 核心工作流程

### 1. 充电控制工作队列 `dc_control_work()`

**执行周期：** 动态调整（200ms-1000ms）

**工作流程：**

```c
dc_control_work():
    1. 检查停止充电标志
       └─ if (stop_charging_flag || force_disable)
              goto out

    2. 检查优先级反转
       └─ if (priority_inversion)
              goto out
    
    3. 检查模式切换需求
       └─ 最优模式 = dc_pmode_get_optimal_mode()
          if (current_mode != optimal_mode)
              set_need_recheck_flag(true)
              goto out
    
    4. 多 IC 检查
       └─ mulit_ic_check()
          ├─ 检查各 IC 工作状态
          ├─ 负载均衡调整
          └─ 异常 IC 处理
    
    5. 充电完成检查
       └─ if (cur_stage == 2 × stage_size || timeout)
              DC_STAGE_CHARGE_DONE
              goto out
    
    6. 充电路径选择
       └─ dc_select_charge_path()
    
    7. 充电调节
       └─ dc_charge_regulation()
          └─ CC/CV 控制（见下文）
    
    8. 充电信息更新
       └─ direct_charge_update_charge_info()
    
    9. 重新调度
       └─ hrtimer_start(&control_timer, interval)

out:
    direct_charge_stop_charging()
```

### 2. CC/CV 调节算法 `dc_cccv_regulation_by_ibat()`

**调节目标：** 保持充电电流在 `cur_ibat_th_low` ~ `cur_ibat_th_high` 区间

**调节策略：**

```c
dc_cccv_regulation_by_ibat():
    1. 电压阶段切换检查
       if (奇数阶段 && vbat > cur_vbat_th)
           // 电压达到阈值，切换到下一阶段
           adaptor_vset += volt_ratio × (cur_vbat_th - vbat)
           dc_set_adapter_voltage(adaptor_vset)
           return
    
    2. 过流保护
       if (ibat > cur_ibat_th_high || ls_ibus × volt_ratio > cur_ibat_th_high + delta_err)
           // 充电电流超过上限，降低适配器电压
           adaptor_vset -= vstep
           dc_set_adapter_voltage(adaptor_vset)
           return
    
    3. 适配器电流增加
       if (adaptor_iset < max_adap_cur)
           // 适配器电流未达最大，增加电流
           adaptor_iset += 1000mA（步进）
           dc_set_adapter_current(adaptor_iset)
           return
    
    4. 适配器 CC 保护检查
       if (adaptor_vset - vadapt >= vadapt_diff_th)
           // 适配器电压偏差过大，不调整
           return
    
    5. 欠流补偿
       if (ibat < cur_ibat_th_high && ls_ibus × volt_ratio - cur_ibat_th_high < delta_err)
           // 充电电流低于目标，提高适配器电压
           adaptor_vset += vstep
           dc_set_adapter_voltage(adaptor_vset)
           return
```

**示例调节过程：**

```
阶段 4：vol_th=4350mV, cur_th_high=4000mA, cur_th_low=3500mA

时刻 1：vbat=4320mV, ibat=3800mA
  → ibat 在范围内，提高电压
  → adaptor_vset += 10mV

时刻 2：vbat=4330mV, ibat=4100mA
  → ibat > cur_th_high（4000mA），降低电压
  → adaptor_vset -= 10mV

时刻 3：vbat=4355mV, ibat=3900mA
  → vbat > vol_th（4350mV），切换到阶段 5
  → adaptor_vset += 2 × (4350 - 4355) = -10mV
```

### 3. 阈值计算工作队列 `dc_calc_thld_work()`

**功能：** 根据电池状态动态选择充电阶段和参数

```c
dc_calc_thld_work():
    1. 检查停止标志
    
    2. SOH 策略调整
       └─ direct_charge_soh_policy()
          └─ 根据电池健康度调整充电参数
    
    3. 选择充电阶段
       └─ direct_charge_select_charging_stage()
          ├─ 根据电池电压查找匹配的阶段
          └─ 更新 cur_stage, cur_vbat_th, cur_ibat_th_xxx
    
    4. 选择充电参数
       └─ direct_charge_select_charging_param()
          ├─ 温度补偿
          ├─ 电池组参数
          └─ 时间衰减
    
    5. 重新调度
       └─ hrtimer_start(&calc_thld_timer, interval)
```

### 4. 异常检测工作队列 `dc_anomaly_det_work()`

**功能：** 检测 22.5W 快充协议（如华为 SCP）的异常情况

```c
dc_anomaly_det_work():
    1. 检查停止标志
    
    2. 执行 22.5W 检测
       └─ dc_adpt_22p5w_det()
          ├─ 检测适配器输出是否异常
          └─ 如果检测到异常，触发降级
    
    3. 重新调度
       └─ hrtimer_start(&anomaly_det_timer, interval)
```

---

## 多 IC 管理机制

### 1. 单 IC vs 双 IC 切换

**切换阈值：**

```c
#define DC_SINGLEIC_CURRENT_LIMIT  8000   // 单 IC 电流上限 8A
#define DC_MULTI_IC_IBAT_TH        4000   // 双 IC 启动阈值 4A
#define MIN_CURRENT_FOR_MULTI_IC   500    // 双 IC 最小电流 500mA
```

**切换逻辑：**

```c
if (ibat > DC_SINGLEIC_CURRENT_LIMIT)
    // 电流超过 8A，启动双 IC 并联
    enable_aux_ic()
else if (ibat < DC_MULTI_IC_IBAT_TH && aux_ic_enabled)
    // 电流低于 4A，关闭辅助 IC
    disable_aux_ic()
```

### 2. 负载均衡算法 `mulit_ic_check()`

**功能：** 检测并调整双 IC 之间的负载分配

```c
mulit_ic_check():
    1. 读取主 IC 和辅助 IC 的 Ibus
       ├─ dcm_get_ic_ibus(MAIN_IC, &ibus_main)
       └─ dcm_get_ic_ibus(AUX_IC, &ibus_aux)
    
    2. 计算电流差异
       └─ diff = abs(ibus_main - ibus_aux)
    
    3. 负载均衡调整
       if (diff > threshold)
           // 调整 IC 配置，平衡负载
           adjust_ic_configuration()
    
    4. 异常 IC 检测
       if (ibus_main == 0 || ibus_aux == 0)
           // 某个 IC 失效，切换到单 IC 模式
           disable_failed_ic()
```

---

## 模式切换机制

### 模式优先级

**优先级排序：** SC4 > SC > LVC

**切换逻辑：**

```c
dc_pmode_get_optimal_mode():
    1. 获取当前电池状态
       ├─ vbat = get_battery_voltage()
       ├─ ibat = get_battery_current()
       └─ temp = get_battery_temperature()
    
    2. 遍历模式优先级列表
       for (mode in [SC4, SC, LVC]):
           if (mode_is_supported(mode) && mode_is_safe(vbat, ibat, temp))
               return mode
    
    3. 返回默认模式
       └─ return current_mode
```

### 模式切换流程

```
场景：SC 模式 → LVC 模式

1. dc_pmode_get_optimal_mode() 检测到 LVC 更优
   ↓
2. 设置 need_recheck_flag = true
   ↓
3. dc_control_work() 检测到标志位
   ↓
4. 调用 direct_charge_stop_charging()
   ├─ 停止当前 SC 充电
   ├─ 关闭 SC IC
   └─ 恢复路径到 Buck
   ↓
5. charge_manager 重新检测充电器类型
   ↓
6. direct_charge_check() 重新运行
   ├─ 检测到 LVC 可用
   └─ 启动 LVC 充电
```

---

## 安全保护机制

### 1. 电池异常电流检测 `dc_ctrl_is_ibat_abnormal()`

**检测条件：**

```c
1. 电压异常检查（如果跳过安全检查）
   └─ output_volt - vusb < 100mV

2. 电流异常检查
   └─ output_curr < ibat_abnormal_th

3. 连续异常次数
   └─ 连续 10 次检测到异常，触发错误
```

**示例：**

```
适配器输出：10V @ 2A
VUSB 测量：9.5V
充电电流阈值：1.5A

检查 1：output_volt - vusb = 10V - 9.5V = 0.5V > 0.1V（电压正常）
检查 2：output_curr = 2A > 1.5A（电流正常）

如果连续 10 次检测到异常 → 触发 DC_EH_IBAT_ABNORMAL 错误
```

### 2. 过压保护

**检测项：**
- 适配器输出电压 > 最大安全电压
- VBUS 电压 > 电池电压 + 安全裕量
- IC 输入电压超限

### 3. 过流保护

**检测项：**
- 适配器输出电流 > 协议最大电流
- 电池充电电流 > 阶段限制电流
- IC 输入电流超限

### 4. 温度保护

**检测项：**
- 电池温度超出安全范围
- IC 温度过高
- 电缆温度过高（如支持）

---

## DTS 配置示例

```
direct_charge_sc {
    compatible = "huawei,direct_charge_sc";
    
    /* 基本参数 */
    dc_volt_ratio = <2>;  // SC 模式 2:1 转换比
    init_adapter_vset = <4400>;  // 初始适配器电压（mV）
    init_delt_vset = <200>;  // 初始电压裕量（mV）
    
    /* 温度补偿表 */
    temp_para = <
        /* temp_min temp_max temp_cur_max */
        -200  100  1000    /* 极低温 */
        100   150  3000    /* 低温 */
        150   450  6000    /* 正常 */
        450   500  3000    /* 高温 */
        500   600  1000    /* 极高温 */
    >;
    
    /* CC/CV 多阶段参数 */
    volt_para = <
        /* vol_th cur_th_high cur_th_low */
        3400  6000  5500
        3700  6000  5500
        4000  5000  4500
        4200  5000  4500
        4350  4000  3500
        4400  4000  3500
        4450  2000  1500
        4480  1000  500
    >;
    
    /* 电池组参数 */
    bat_para = <
        /* bat_id temp_low temp_high volt_para_index */
        0  100  450  "volt_para_0"
        1  100  450  "volt_para_1"
    >;
    
    /* 多 IC 配置 */
    multi_ic_mode_para = <
        /* ibat_th curr_offset */
        4000  300
    >;
    
    /* 时间衰减参数 */
    time_para = <
        /* time_th ibat_max */
        0     6000
        600   5000  /* 10 分钟后降到 5A */
        1800  4000  /* 30 分钟后降到 4A */
    >;
};
```

---

## 调试技巧

### 1. 查看当前充电阶段

```bash
cat /sys/class/hw_power/direct_charger_sc/charging_stage
```

输出示例：
```
4  // 当前处于第 4 阶段
```

### 2. 查看充电参数

```bash
cat /sys/class/hw_power/direct_charger_sc/iin_thermal
cat /sys/class/hw_power/direct_charger_sc/adaptor_voltage
cat /sys/class/hw_power/direct_charger_sc/battery_voltage
cat /sys/class/hw_power/direct_charger_sc/battery_current
```

### 3. 强制禁用直充

```bash
echo 1 > /sys/class/hw_power/direct_charger_sc/enable_charger
```

### 4. 查看错误日志

```bash
dmesg | grep "direct_charge" | grep -E "error|err"
```

常见错误日志：
```
direct_charge: DC_EH_IBAT_ABNORMAL  # 电流异常
direct_charge: DC_EH_ADAPTER_OTP    # 适配器过温
direct_charge: DC_EH_BATTERY_OVP    # 电池过压
```

### 5. 监控 CC/CV 调节过程

在 direct_charge_control.c 中添加日志：

```c
hwlog_info("cccv_reg: stage=%d, vbat=%d, ibat=%d, adaptor_vset=%d, adaptor_iset=%d\n",
    di->cur_stage, di->vbat, ibat, di->adaptor_vset, di->adaptor_iset);
```

### 6. 验证多 IC 切换

```bash
# 查看多 IC 状态
cat /sys/class/hw_power/direct_charger_sc/multi_ic_mode

# 查看各 IC 电流
cat /sys/class/hw_power/direct_charger_sc/main_ibus
cat /sys/class/hw_power/direct_charger_sc/aux_ibus
```

---

## 典型应用场景

### 场景 1：SC 模式 100W 快充

**硬件配置：**
- 适配器：20V @ 5A（100W）
- 电池：4.4V @ 2000mAh × 2 并联
- SC IC：2:1 转换

**充电流程：**

```
1. 适配器检测
   └─ 协商 PD 20V 5A

2. 模式选择
   └─ SC 模式（2:1 转换）

3. 初始化（阶段 0）
   ├─ vbat = 3400mV
   ├─ adaptor_vset = 2 × 3400 + 200 = 7000mV
   └─ ibat = 6000mA

4. 充电中（阶段 4）
   ├─ vbat = 4350mV
   ├─ adaptor_vset = 2 × 4350 = 8700mV
   ├─ adaptor_iset = 4000 / 2 = 2000mA
   └─ ibat = 4000mA（CC 恒流）

5. 充电后期（阶段 7）
   ├─ vbat = 4480mV（接近满电）
   ├─ adaptor_vset = 2 × 4480 = 8960mV
   ├─ ibat = 1000mA → 500mA（CV 恒压）
   └─ 转入涓流充电

6. 充电完成
   └─ ibat < 500mA，切换到 Buck 补电
```

### 场景 2：SC4 模式 200W 超快充

**硬件配置：**
- 适配器：40V @ 5A（200W）
- 电池：4.5V @ 5000mAh × 2 并联
- SC4 IC：4:1 转换

**充电流程：**

```
1. 适配器协商
   └─ UFCS 协议 40V 5A

2. 模式选择
   └─ SC4 模式（4:1 转换）

3. 初始化
   ├─ adaptor_vset = 4 × 3400 + 400 = 14000mV（35V）
   └─ ibat = 12000mA（峰值）

4. 充电中
   ├─ adaptor_vset = 4 × 4400 = 17600mV（44V）
   ├─ adaptor_iset = 10000 / 4 = 2500mA
   └─ ibat = 10000mA

5. 温度限制
   └─ temp = 48°C → 降低到 3000mA

6. 双 IC 并联
   ├─ ibat = 10000mA > 8000mA
   ├─ 启动辅助 IC
   ├─ main_ic_ibus = 5000mA
   └─ aux_ic_ibus = 5000mA
```

### 场景 3：LVC → SC 模式切换

**切换触发条件：**
- 电池电压降低
- 适配器支持更高电压
- 温度条件改善

**切换流程：**

```
1. LVC 充电中
   ├─ vbat = 9.5V（高压单体电池）
   └─ ibat = 3000mA

2. 检测到电池电压降低
   └─ vbat = 4.2V × 2 = 8.4V

3. dc_pmode_get_optimal_mode() 判断
   └─ SC 模式更优（可用更高电流）

4. 设置 need_recheck_flag = true

5. 停止 LVC 充电
   ├─ 关闭 LVC IC
   └─ 恢复到 Buck 充电

6. 重新检测
   └─ 启动 SC 充电

7. SC 充电
   ├─ vbat = 4200mV × 2 = 8400mV
   ├─ adaptor_vset = 2 × 8400 = 16800mV
   └─ ibat = 6000mA（提高充电功率）
```

---

## 总结

`direct_charge` 模块通过**多模式转换、多阶段CC/CV、多IC协同、智能安全保护**，实现了高效、安全的直充快充技术。核心亮点包括：

1. **多模式支持：** LVC、SC、SC4 三种转换模式，自动选择最优模式
2. **多阶段充电：** 8 级 CC/CV 精细控制，平衡充电速度和电池寿命
3. **智能调节算法：** 实时调整适配器电压电流，保持充电电流在目标范围
4. **多 IC 协同：** 单 IC/双 IC 动态切换，负载均衡，提高功率上限
5. **温度补偿：** 5 级温度分段，动态调整充电参数，确保安全
6. **安全保护：** 过压、过流、过温、电流异常等多重检测，实时保护
7. **协议兼容：** 支持 PD、SCP、FCP、UFCS 等多种快充协议
8. **模式切换：** 根据电池状态动态切换充电模式，优化充电效率

该模块是华为超级快充技术的核心实现，支持高达 200W+ 的充电功率，广泛应用于旗舰手机、折叠屏等高端设备中。