---
outline: deep
---
# 华为充电管理之buck_charge 充电模式

## 模块概述

`buck_charge` 是华为充电管理子系统中的 **Buck 充电控制模块**，负责管理**常规降压（Buck）充电**过程，包括 **JEITA 温度补偿、充电完成检测、智能电池配置、FFC（Fast Full Charge）控制**等功能。该模块与直充（Direct Charge）模块协同工作，在非直充场景下提供标准的 CC/CV 充电控制。

**核心功能：**
- **JEITA 温度补偿：** 根据电池温度动态调整充电电流和电压
- **充电完成检测：** 基于截止电流（Iterm）和电压判断充电是否完成
- **强制截止功能：** 充电完成时提高 Iterm 阈值，强制停止充电
- **智能电池支持：** 从智能电池 IC 读取期望的充电参数
- **FFC 集成：** 支持快速满充（Fast Full Charge）增压
- **投票机制集成：** 通过 vote 系统动态调整充电参数
- **充电完成后限流：** 充电完成后降低输入电流，延长电池寿命

**架构图：**

```
┌─────────────────────────────────────────────────┐
│            Buck Charge Module                   │
│  ┌──────────────────────────────────────────┐  │
│  │       Monitor Work (10s cycle)           │  │
│  │  ┌────────────────────────────────────┐  │  │
│  │  │ 1. JEITA Temperature Handler       │  │  │
│  │  │ 2. Smart Battery Config            │  │  │
│  │  │ 3. FFC Voltage Increment           │  │  │
│  │  │ 4. Thermal Current Limit           │  │  │
│  │  │ 5. Force Termination Check         │  │  │
│  │  └────────────────────────────────────┘  │  │
│  └──────────────────────────────────────────┘  │
└──────────────┬──────────────────────────────────┘
               │
      ┌────────┴────────┐
      │                 │
┌─────▼─────┐     ┌────▼──────┐
│ Vote      │     │ Charge    │
│ System    │     │ IC Driver │
│ (FCC/     │     │ (Buck)    │
│  VTERM/   │     │           │
│  USB_ICL) │     │           │
└───────────┘     └───────────┘
```

---

## 主要数据结构

### 1. 设备结构体 `buck_charge_dev`

```c
struct buck_charge_dev {
    struct device *dev;                          // 设备指针
    
    /* 配置参数 */
    u32 jeita_support;                           // JEITA 温度补偿支持标志
    u32 force_term_support;                      // 强制截止支持标志
    u32 vterm;                                   // 充电截止电压（mV，默认 4450）
    u32 iterm;                                   // 充电截止电流（mA，默认 160）
    u32 ibus_limit_after_chg_done;               // 充电完成后输入电流限制（mA）
    
    /* 运行时状态 */
    u32 check_full_count;                        // 充电完成检测计数器
    bool charging_on;                            // 充电中标志
    
    /* 工作队列 */
    struct delayed_work buck_charge_work;        // 监控工作队列（10s 周期）
    struct work_struct stop_charge_work;         // 停止充电工作队列
    
    /* 事件通知 */
    struct notifier_block event_nb;              // 充电事件通知块（POWER_BNT_CHARGING）
    struct notifier_block chg_event_nb;          // 充电状态通知块（POWER_BNT_CHG）
    
    /* JEITA 温度补偿 */
    struct bc_jeita_para jeita_table[BC_JEITA_PARA_LEVEL];  // JEITA 参数表（6 级）
    struct bc_jeita_result jeita_result;         // JEITA 计算结果
};
```

### 2. JEITA 参数结构体 `bc_jeita_para`

```c
struct bc_jeita_para {
    int temp_min;      // 温度区间下限（0.1°C）
    int temp_max;      // 温度区间上限（0.1°C）
    int iin_limit;     // 输入电流限制（mA）
    int ichg_limit;    // 充电电流限制（mA）
    int vterm;         // 充电截止电压（mV）
    int temp_back;     // 温度回滞（0.1°C）
};
```

**JEITA 参数表级数：** 6 级（BC_JEITA_PARA_LEVEL = 6）

### 3. JEITA 结果结构体 `bc_jeita_result`

```c
struct bc_jeita_result {
    int iin;    // 输入电流限制（mA）
    int ichg;   // 充电电流限制（mA）
    int vterm;  // 充电截止电压（mV）
};
```

---

## 核心功能

### 1. 充电完成检测 `buck_charge_is_charging_full()`

**检测条件：**

```c
1. 电池必须存在
   └─ power_platform_is_battery_exit()

2. 电压条件
   └─ vbat >= (vterm - vterm_dec - 20mV)
      其中 vterm_dec 是 vote 系统动态调整的电压偏移

3. 充电使能
   └─ charge_enable == true

4. 电流条件（连续 3 次满足）
   ├─ ichg > -10mA（充电电流大于偏移量）
   ├─ ichg_avg > -10mA（平均充电电流）
   └─ ichg < iterm && ichg_avg < iterm
      其中 iterm 从 vote 系统获取，默认 160mA
```

**检测流程：**

```c
buck_charge_is_charging_full():
    1. 检查电池存在性
       └─ if (!power_platform_is_battery_exit())
              return false;
    
    2. 检查电压条件
       └─ vbat = power_supply_app_get_bat_voltage_now()
          if (vbat < vterm - vterm_dec - 20mV)
              return false;
    
    3. 检查充电使能
       └─ charge_enable = charge_get_charge_enable_status()
          if (!charge_enable)
              return false;
    
    4. 检查电流条件
       ├─ ichg = -power_platform_get_battery_current()
       ├─ ichg_avg = charge_get_battery_current_avg()
       ├─ iterm_th = vote 系统获取（VOTE_OBJ_ITERM）
       └─ if (ichg > -10 && ichg_avg > -10 && ichg < iterm_th && ichg_avg < iterm_th)
              check_full_count++
              if (check_full_count >= 3)
                  return true  // 充电完成
          else
              check_full_count = 0
```

**示例日志：**

```
buck_charge: ichg=120, ichg_avg=115, iterm_th=160, capacity=100
buck_charge: check_full_count=3, charge_full=true
```

### 2. 强制截止功能 `buck_charge_force_termination()`

**功能说明：** 充电完成时，将 Iterm 阈值提高到 750mA，强制停止充电，避免涓流充电持续过久。

**实现逻辑：**

```c
buck_charge_force_termination():
    if (!force_term_support)
        return;  // 未使能，跳过
    
    flag = buck_charge_is_charging_full()
    
    if (flag)
        // 充电完成，提高 Iterm 到 750mA
        chg_vote_set(VOTE_OBJ_ITERM, VOTE_CLIENT_USER, true, 750)
    else
        // 未完成，清除投票
        chg_vote_set(VOTE_OBJ_ITERM, VOTE_CLIENT_USER, true, 0)
```

**设计目的：**
- **快速截止：** 避免小电流涓流充电时间过长
- **保护电池：** 减少高电压下的停留时间，延长电池寿命

### 3. 智能电池配置 `buck_charge_smart_battery_config_cc_cv()`

**功能说明：** 对于智能电池（如带 BMS 的电池包），从电池 IC 读取期望的充电参数，并通过 vote 系统设置。

**实现流程：**

```c
buck_charge_smart_battery_config_cc_cv():
    1. 读取期望充电电流
       └─ charge_current = coul_interface_get_desired_charging_current(COUL_TYPE_MAIN)
    
    2. 读取期望充电电压
       └─ charge_voltage = coul_interface_get_desired_charging_voltage(COUL_TYPE_MAIN)
          if (charge_voltage <= 0)
              charge_voltage = di->vterm  // 使用默认值
    
    3. 通过 vote 系统设置
       ├─ chg_vote_set(VOTE_OBJ_FCC, VOTE_CLIENT_SMT_BATT, true, charge_current)
       └─ chg_vote_set(VOTE_OBJ_VTERM, VOTE_CLIENT_SMT_BATT, true, charge_voltage)
```

**应用场景：** 电池包带智能 BMS（Battery Management System），可根据电池状态动态调整充电策略。

### 4. JEITA 温度补偿 `buck_charge_jeita_tbatt_handler()`

**JEITA 标准：** JEITA（Japan Electronics and Information Technology Industries Association）电池充电温度补偿标准。

**温度分级示例：**

| 温度区间 | temp_min | temp_max | iin_limit | ichg_limit | vterm | temp_back |
|---------|----------|----------|-----------|------------|-------|-----------|
| 极低温 | -200 | 0 | 500 | 200 | 4100 | 20 |
| 低温 | 0 | 100 | 1000 | 500 | 4200 | 20 |
| 正常低温 | 100 | 150 | 2000 | 1000 | 4350 | 20 |
| 正常温度 | 150 | 450 | 3000 | 2000 | 4450 | 20 |
| 高温 | 450 | 500 | 2000 | 1000 | 4200 | 30 |
| 极高温 | 500 | 600 | 500 | 200 | 4100 | 30 |

**温度回滞逻辑：**

```c
温度上升时：直接切换到新温度区间
温度下降时：
    if (温度距离新区间上限 > temp_back)
        切换到新区间
    else
        保持原区间参数（防止频繁切换）
```

**实现代码：**

```c
buck_charge_jeita_tbatt_handler(int temp, jeita_table[], result):
    1. 查找匹配的温度区间
       for (i = 0; i < 6; i++) {
           if (temp >= jeita_table[i].temp_min && temp < jeita_table[i].temp_max)
               找到区间 i
       }
    
    2. 温度回滞判断
       if ((last_temp - temp <= 0) ||  // 温度上升
           (jeita_table[i].temp_max - temp > jeita_table[i].temp_back) ||  // 温度距上限足够远
           (abs(last_i - i) > 1) ||  // 跨区间
           (first_run))  // 首次运行
       {
           // 更新参数
           result->iin = jeita_table[i].iin_limit
           result->ichg = jeita_table[i].ichg_limit
           result->vterm = jeita_table[i].vterm
       } else {
           // 保持旧参数（回滞）
           result->iin = last_iin
           result->ichg = last_ichg
           result->vterm = last_vterm
       }
    
    3. 记录状态
       last_i = i
       last_temp = temp
       last_iin/ichg/vterm = result->xxx
```

**示例场景（温度下降）：**

```
当前状态：温度 455°C（高温区间），ichg=1000mA, vterm=4200mV
温度下降到 445°C：
    - 445°C 位于正常温度区间（150-450°C）
    - 距离高温区间上限（500°C）= 500 - 445 = 55°C
    - temp_back = 30°C
    - 55°C > 30°C，切换到正常温度区间
    - ichg=2000mA, vterm=4450mV

温度下降到 475°C：
    - 475°C 位于正常温度区间
    - 距离高温区间上限 = 500 - 475 = 25°C
    - 25°C < 30°C（temp_back），保持高温区间参数
    - ichg=1000mA, vterm=4200mV（不变）
```

### 5. FFC 电压增量 `charge_set_buck_fv_delta()`

**FFC（Fast Full Charge）：** 快速满充技术，在充电后期动态提高充电电压，加快充电速度。

**工作流程：**

```c
buck_charge_monitor_work():
    1. 获取 FFC 电压增量
       └─ increase_volt = ffc_ctrl_get_incr_vterm()
    
    2. 设置到充电芯片
       └─ charge_set_buck_fv_delta(increase_volt)
    
    3. 通知 FFC 控制模块
       └─ ffc_ctrl_notify_ffc_info()
```

**电压增量示例：**

| 充电阶段 | FFC 增量 | 实际 Vterm |
|---------|---------|-----------|
| 前期（SOC < 80%） | 0mV | 4450mV |
| 中期（80% ≤ SOC < 95%） | 50mV | 4500mV |
| 后期（SOC ≥ 95%） | 100mV | 4550mV |

---

## 监控工作队列

### 监控工作 `buck_charge_monitor_work()`

**执行周期：** 10 秒（BUCK_CHARGE_WORK_TIMEOUT = 10000ms）

**工作流程：**

```c
buck_charge_monitor_work():
    1. 检查充电状态
       └─ if (!charging_on) return;
    
    2. 获取电池温度
       └─ bat_temp_get_temperature(BAT_TEMP_MIXED, &tbat)
    
    3. FFC 电压增量处理
       ├─ increase_volt = ffc_ctrl_get_incr_vterm()
       └─ charge_set_buck_fv_delta(increase_volt)
    
    4. 智能电池配置
       └─ if (coul_interface_is_smart_battery())
              buck_charge_smart_battery_config_cc_cv()
    
    5. JEITA 温度补偿
       └─ if (jeita_support)
              buck_charge_jeita_tbatt_handler(tbat, jeita_table, &jeita_result)
              chg_vote_set(VOTE_OBJ_FCC, VOTE_CLIENT_JEITA, true, jeita_result.ichg)
              chg_vote_set(VOTE_OBJ_VTERM, VOTE_CLIENT_JEITA, true, jeita_result.vterm)
    
    6. 热管理电流限制
       └─ charge_update_buck_iin_thermal()
    
    7. FFC 信息通知
       └─ ffc_ctrl_notify_ffc_info()
    
    8. 强制截止检测
       └─ buck_charge_force_termination()
    
    9. 重新调度
       └─ schedule_delayed_work(&buck_charge_work, 10s)
```

### 停止充电工作 `buck_charge_stop_monitor_work()`

**功能：** 充电停止时清理状态和复位投票。

```c
buck_charge_stop_monitor_work():
    1. 清除 FFC 电压增量
       └─ charge_set_buck_fv_delta(0)
    
    2. 复位 Iterm 投票
       └─ chg_vote_set(VOTE_OBJ_ITERM, VOTE_CLIENT_FFC, true, di->iterm)
    
    3. 清除 USB ICL 投票
       ├─ chg_vote_set(VOTE_OBJ_USB_ICL, VOTE_CLIENT_FCP, false, 0)
       ├─ chg_vote_set(VOTE_OBJ_USB_ICL, VOTE_CLIENT_RT, false, 0)
       └─ chg_vote_set(VOTE_OBJ_USB_ICL, VOTE_CLIENT_USER, false, 0)
```

---

## 事件通知机制

### 1. 充电事件通知 `buck_charge_event_notifier_call()`

**监听事件：** POWER_BNT_CHARGING

| 事件 | 处理 |
|------|------|
| `POWER_NE_CHARGING_START` | 设置 charging_on=true，立即启动监控工作队列 |
| `POWER_NE_CHARGING_STOP` | 设置 charging_on=false，调度停止充电工作队列 |

```c
POWER_NE_CHARGING_START:
    di->charging_on = true
    schedule_delayed_work(&buck_charge_work, 0)  // 立即执行

POWER_NE_CHARGING_STOP:
    di->charging_on = false
    schedule_work(&stop_charge_work)  // 异步清理
```

### 2. 充电状态通知 `buck_charge_chg_event_notifier_call()`

**监听事件：** POWER_BNT_CHG

| 事件 | 处理 |
|------|------|
| `POWER_NE_CHG_CHARGING_DONE` | 充电完成，限制输入电流到配置值 |
| `POWER_NE_CHG_CHARGING_RECHARGE` | 重新充电，取消输入电流限制 |

```c
POWER_NE_CHG_CHARGING_DONE:
    if (ibus_limit_after_chg_done)
        chg_vote_set(VOTE_OBJ_USB_ICL, VOTE_CLIENT_USER, true, ibus_limit_after_chg_done)

POWER_NE_CHG_CHARGING_RECHARGE:
    if (ibus_limit_after_chg_done)
        chg_vote_set(VOTE_OBJ_USB_ICL, VOTE_CLIENT_USER, false, 0)
```

**设计目的：** 充电完成后降低输入电流（如从 2000mA 降到 500mA），减少满电停留时间，延长电池寿命。

---

## Vote 系统集成

### Vote 对象类型

| Vote 对象 | Vote 客户端 | 说明 |
|----------|-----------|------|
| `VOTE_OBJ_FCC` | VOTE_CLIENT_JEITA | JEITA 充电电流限制 |
| `VOTE_OBJ_FCC` | VOTE_CLIENT_SMT_BATT | 智能电池充电电流 |
| `VOTE_OBJ_VTERM` | VOTE_CLIENT_JEITA | JEITA 充电电压 |
| `VOTE_OBJ_VTERM` | VOTE_CLIENT_SMT_BATT | 智能电池充电电压 |
| `VOTE_OBJ_ITERM` | VOTE_CLIENT_USER | 强制截止电流 |
| `VOTE_OBJ_ITERM` | VOTE_CLIENT_FFC | FFC 截止电流 |
| `VOTE_OBJ_USB_ICL` | VOTE_CLIENT_FCP | FCP 输入电流限制 |
| `VOTE_OBJ_USB_ICL` | VOTE_CLIENT_USER | 充电完成输入电流限制 |

### Vote 优先级机制

**示例（FCC 投票）：**

```
VOTE_CLIENT_JEITA: 1000mA  // JEITA 温度限制
VOTE_CLIENT_SMT_BATT: 2000mA  // 智能电池请求
VOTE_CLIENT_THERMAL: 500mA  // 热管理限制

最终生效值：min(1000, 2000, 500) = 500mA（取最小值）
```

---

## DTS 配置

### 配置示例

```
buck_charge {
    compatible = "huawei,buck_charge";
    
    /* 基本参数 */
    vterm = <4450>;  // 充电截止电压 4.45V
    iterm = <160>;   // 充电截止电流 160mA
    
    /* 功能开关 */
    jeita_support = <1>;          // 使能 JEITA 温度补偿
    force_term_support = <1>;     // 使能强制截止
    
    /* 充电完成后输入电流限制 */
    ibus_limit_after_chg_done = <500>;  // 充电完成后限制到 500mA
    
    /* JEITA 温度补偿表 */
    jeita_table = <
        /* temp_min temp_max iin_limit ichg_limit vterm temp_back */
        -200  0    500   200   4100  20   /* 极低温 */
        0     100  1000  500   4200  20   /* 低温 */
        100   150  2000  1000  4350  20   /* 正常低温 */
        150   450  3000  2000  4450  20   /* 正常温度 */
        450   500  2000  1000  4200  30   /* 高温 */
        500   600  500   200   4100  30   /* 极高温 */
    >;
};
```

### 参数说明

| 参数 | 类型 | 默认值 | 说明 |
|------|------|-------|------|
| `vterm` | u32 | 4450 | 充电截止电压（mV） |
| `iterm` | u32 | 160 | 充电截止电流（mA） |
| `jeita_support` | u32 | 0 | JEITA 温度补偿使能（0=禁用, 1=使能） |
| `force_term_support` | u32 | 0 | 强制截止使能 |
| `ibus_limit_after_chg_done` | u32 | 0 | 充电完成后输入电流限制（mA，0=禁用） |
| `jeita_table` | array | - | JEITA 参数表（6 行 × 6 列） |

---

## 调试技巧

### 1. 查看充电完成检测日志

```bash
dmesg | grep "buck_charge" | grep "ichg="
```

输出示例：
```
buck_charge: ichg=120, ichg_avg=115, iterm_th=160, capacity=100
buck_charge: check_full_count=1
buck_charge: check_full_count=2
buck_charge: check_full_count=3, charge_full=true
```

### 2. 查看 JEITA 温度补偿

```bash
dmesg | grep "jeita_tbatt_handler"
```

输出示例：
```
buck_charge_jeita: i = 3, temp = 250, data->iin = 3000, data->ichg = 2000, data->vterm = 4450
```

### 3. 查看 JEITA 参数表

```bash
dmesg | grep "temp_para"
```

输出示例：
```
buck_charge_jeita: temp_para[0] -200 0 500 200 4100 20
buck_charge_jeita: temp_para[1] 0 100 1000 500 4200 20
...
```

### 4. 验证强制截止功能

在 buck_charge.c 中添加日志：

```c
hwlog_info("force_term: flag=%d, check_full_count=%d\n", flag, di->check_full_count);
```

### 5. 监控 FFC 电压增量

```bash
dmesg | grep "increase_volt="
```

输出示例：
```
buck_charge: increase_volt=0
buck_charge: increase_volt=50
buck_charge: increase_volt=100
```

### 6. 验证充电完成后限流

```bash
# 充电完成时
dmesg | grep "POWER_NE_CHG_CHARGING_DONE"
cat /sys/class/power_supply/usb/current_max  # 应显示 500000 (500mA)

# 重新充电时
dmesg | grep "POWER_NE_CHG_CHARGING_RECHARGE"
cat /sys/class/power_supply/usb/current_max  # 应恢复到正常值
```

---

## 典型应用场景

### 场景 1：正常温度充电

**流程：**

```
1. 充电开始
   ↓
2. POWER_NE_CHARGING_START 事件
   ↓
3. buck_charge_event_notifier_call()
   ├─ charging_on = true
   └─ schedule_delayed_work(&buck_charge_work, 0)
   ↓
4. buck_charge_monitor_work() 执行（每 10s）
   ├─ 温度 = 250°C（25°C）
   ├─ JEITA 处理：区间 3（正常温度）
   │   ├─ ichg_limit = 2000mA
   │   └─ vterm = 4450mV
   ├─ chg_vote_set(VOTE_OBJ_FCC, VOTE_CLIENT_JEITA, true, 2000)
   ├─ chg_vote_set(VOTE_OBJ_VTERM, VOTE_CLIENT_JEITA, true, 4450)
   ├─ FFC 增量 = 0mV（SOC < 80%）
   └─ 充电未完成，check_full_count = 0
```

### 场景 2：低温充电限制

**流程：**

```
1. 温度下降到 5°C（50°C）
   ↓
2. buck_charge_monitor_work() 执行
   ├─ JEITA 处理：区间 1（低温）
   │   ├─ ichg_limit = 500mA
   │   └─ vterm = 4200mV
   ├─ chg_vote_set(VOTE_OBJ_FCC, VOTE_CLIENT_JEITA, true, 500)
   └─ chg_vote_set(VOTE_OBJ_VTERM, VOTE_CLIENT_JEITA, true, 4200)
   ↓
3. 充电电流降低到 500mA
4. 充电电压降低到 4200mV
```

### 场景 3：充电完成检测

**流程：**

```
1. 充电后期
   ├─ vbat = 4430mV（接近 vterm=4450mV）
   ├─ ichg = 150mA
   └─ ichg_avg = 145mA
   ↓
2. buck_charge_monitor_work() 执行
   ↓
3. buck_charge_is_charging_full()
   ├─ 电压条件：4430 >= 4450 - 0 - 20 ✓
   ├─ 电流条件：150 < 160 && 145 < 160 ✓
   └─ check_full_count = 1
   ↓
4. 下次监控（10s 后）
   ├─ ichg = 148mA, ichg_avg = 142mA
   └─ check_full_count = 2
   ↓
5. 第三次监控
   ├─ ichg = 145mA, ichg_avg = 140mA
   └─ check_full_count = 3 → 充电完成
   ↓
6. buck_charge_force_termination()
   └─ chg_vote_set(VOTE_OBJ_ITERM, VOTE_CLIENT_USER, true, 750)
   ↓
7. Iterm 提高到 750mA，触发截止
```

### 场景 4：智能电池充电

**流程：**

```
1. 检测到智能电池
   └─ coul_interface_is_smart_battery() = true
   ↓
2. buck_charge_monitor_work() 执行
   ↓
3. buck_charge_smart_battery_config_cc_cv()
   ├─ 从电池 IC 读取期望参数
   │   ├─ desired_current = 1800mA
   │   └─ desired_voltage = 4400mV
   ├─ chg_vote_set(VOTE_OBJ_FCC, VOTE_CLIENT_SMT_BATT, true, 1800)
   └─ chg_vote_set(VOTE_OBJ_VTERM, VOTE_CLIENT_SMT_BATT, true, 4400)
   ↓
4. Vote 系统裁决
   ├─ FCC = min(JEITA=2000, SMT_BATT=1800) = 1800mA
   └─ VTERM = min(JEITA=4450, SMT_BATT=4400) = 4400mV
```

### 场景 5：充电完成后限流

**流程：**

```
1. 充电完成
   ↓
2. POWER_NE_CHG_CHARGING_DONE 事件
   ↓
3. buck_charge_chg_event_notifier_call()
   └─ chg_vote_set(VOTE_OBJ_USB_ICL, VOTE_CLIENT_USER, true, 500)
   ↓
4. 输入电流限制到 500mA
   ├─ 减少充电器负载
   └─ 延长电池寿命
   ↓
5. 电池电压下降，触发重新充电
   ↓
6. POWER_NE_CHG_CHARGING_RECHARGE 事件
   ↓
7. buck_charge_chg_event_notifier_call()
   └─ chg_vote_set(VOTE_OBJ_USB_ICL, VOTE_CLIENT_USER, false, 0)
   ↓
8. 取消输入电流限制，恢复正常充电
```

---

## 关键宏定义

```c
#define BATTERY_DEFAULT_VTERM           4450   // 默认充电截止电压（mV）
#define BATTERY_DEFAULT_ITERM           160    // 默认充电截止电流（mA）
#define BUCK_CHARGE_FULL_CHECK_TIMIES   3     // 充电完成检测次数
#define BATTERY_FULL_DELTA_VOTAGE       20     // 充电完成电压偏移（mV）
#define BATTERY_MAX_ITERM               750    // 强制截止最大 Iterm（mA）
#define CHARGING_CURRENT_OFFSET         (-10)  // 充电电流偏移（mA）
#define BUCK_CHARGE_WORK_TIMEOUT        10000  // 监控周期（10s）
#define BC_JEITA_PARA_LEVEL             6      // JEITA 温度分级数
```

---

## 总结

`buck_charge` 模块通过 **JEITA 温度补偿、智能充电完成检测、FFC 快速满充、Vote 系统集成**，实现了智能化的 Buck 充电管理。核心亮点包括：

1. **JEITA 温度补偿：** 6 级温度分段，动态调整充电参数，保护电池安全
2. **温度回滞机制：** 防止温度边界附近频繁切换充电参数
3. **智能充电完成检测：** 基于电压、电流双重条件，连续 3 次确认，避免误判
4. **强制截止功能：** 充电完成时提高 Iterm 阈值，快速停止充电
5. **智能电池支持：** 从 BMS 读取动态充电参数，优化充电策略
6. **FFC 集成：** 充电后期动态增压，加快充电速度
7. **充电完成后限流：** 降低输入电流，延长电池寿命
8. **Vote 系统集成：** 多客户端投票裁决，灵活应对复杂充电场景

该模块与直充模块协同工作，在非直充场景下提供可靠、高效的 Buck 充电控制，是华为充电系统的核心组件之一。