---
outline: deep
---

# 华为电池核心之 battery_ui_capacity 模块代码解析

## 一、模块概述

`battery_ui_capacity` 模块是华为电源管理子系统中的**用户界面电量显示驱动**，负责将底层库仑计（Coulomb Counter）提供的原始 SOC（State of Charge）转换为用户友好、平滑、可靠的 UI 电量百分比。

**核心功能：**
- **电量平滑算法：** 滑动窗口滤波，避免电量跳变
- **充电状态管理：** 充电/放电/满电等状态下的电量逻辑处理
- **强制满电机制：** 接近满电时自动切换到 100%
- **电压校正算法：** 通过电压阈值校正 SOC，防止虚电
- **关机电量校正：** 低电量时通过电压二次校验，避免意外关机
- **假电量过滤：** 支持硅基电池/ECM 模式等特殊场景的电量锁定
- **SOC 异常检测：** 监控电量突变并上报 DSM 故障

**架构图：**

```
┌─────────────────────────────────────────────────┐
│          Battery UI Capacity Module             │
└──────────┬──────────────────────────────────────┘
           │
    ┌──────┴──────┐
    │             │
┌───▼───┐   ┌────▼────┐
│Coul IC│   │ Voltage │
│  SOC  │   │  Check  │
└───┬───┘   └────┬────┘
    │            │
    └─────┬──────┘
          │
    ┌─────▼─────┐
    │ UI Filter │ ← 滑动窗口 + 充电状态检查
    └─────┬─────┘
          │
    ┌─────▼─────┐
    │VTH Correct│ ← 电压阈值校正
    └─────┬─────┘
          │
    ┌─────▼─────┐
    │Fake Filter│ ← 假电量过滤（硅基电池/ECM）
    └─────┬─────┘
          │
    ┌─────▼─────┐
    │ UI SOC(%) │ → power_supply → Android
    └───────────┘
```

---

## 二、主要数据结构

### 2.1 主设备结构体 `bat_ui_capacity_device`

```c
struct bat_ui_capacity_device {
    struct device *dev;
    struct delayed_work update_work;       // 电量更新工作队列
    struct delayed_work wait_work;         // 等待库仑计就绪工作队列
    struct wakeup_source *wakelock;        // 唤醒锁
    struct mutex update_lock;              // 更新互斥锁
    
    /* 充电状态 */
    int charge_status;                     // CHARGING/DISCHARGING/FULL/NOT_CHARGING
    
    /* SOC 缩放参数 */
    int ui_cap_zero_offset;                // UI 电量零点偏移（%）
    int soc_at_term;                       // 终止充电时的 SOC（用于缩放）
    
    /* 电量值 */
    int ui_capacity;                       // 当前 UI 电量（%）
    int ui_prev_capacity;                  // 上次 UI 电量（%）
    int prev_soc;                          // 上次记录的 SOC
    
    /* 电池状态 */
    int bat_exist;                         // 电池是否存在
    int bat_volt;                          // 电池电压（mV）
    int bat_cur;                           // 电池电流（mA）
    int bat_temp;                          // 电池温度（0.1°C）
    int bat_max_volt;                      // 电池最大电压（mV）
    
    /* 滑动窗口滤波器 */
    int capacity_filter[BUC_WINDOW_LEN];   // 电量滤波数组（默认 10 个元素）
    int capacity_sum;                      // 滤波器总和
    int capacity_filter_count;             // 滤波器计数器
    int filter_len;                        // 滤波器长度
    
    /* 电压校正 */
    int vth_correct_en;                    // 电压阈值校正使能
    struct bat_ui_soc_calibration_para vth_soc_calibration_data[2];
    
    /* 强制满电 */
    int chg_force_full_soc_thld;           // 强制满电 SOC 阈值（默认 95%）
    int chg_force_full_count;              // 强制满电计数器
    int chg_force_full_wait_time;          // 强制满电等待时间
    
    /* 关机电量校正 */
    int correct_shutdown_soc_en;           // 关机校正使能
    int shutdown_flag;                     // 关机校正标志
    int shutdown_cap;                      // 关机电量阈值（默认 1%）
    int shutdown_gap;                      // 关机电量间隙（默认 2%）
    int shutdown_vth;                      // 关机电压阈值（mV）
    
    /* 监控参数 */
    u16 monitoring_interval;               // 当前监控间隔（ms）
    int interval_charging;                 // 充电监控间隔（默认 5s）
    int interval_normal;                   // 正常监控间隔（默认 10s）
    int interval_lowtemp;                  // 低温监控间隔（默认 5s）
    int soc_monitor_limit;                 // SOC 变化监控限制（默认 15%）
    int soc_monitor_flag;                  // SOC 监控状态标志
    int soc_monitor_cnt;                   // SOC 监控计数器
    
    /* 其他 */
    int wait_cnt;                          // 等待计数器
    int wait_max_time;                     // 最大等待时间（默认 120s）
    int cap_jump_th;                       // 电量跳变阈值（默认 7%）
    u32 disable_pre_vol_check;             // 禁用低电量电压检查
    struct notifier_block event_nb;        // 充电事件通知块
};
```

### 2.2 电压-SOC 校正参数 `bat_ui_soc_calibration_para`

```c
struct bat_ui_soc_calibration_para {
    int soc;   // 校正后的 SOC 阈值
    int volt;  // 触发校正的电压阈值（mV）
};
```

**用途：** 放电时，若 SOC < `soc` 且电压 ≥ `volt`，则锁定电量为 `soc`，避免虚电掉电过快。

### 2.3 假电量策略 `bat_fake_cap_policy`

```c
struct bat_fake_cap_policy {
    int index;                      // 策略索引
    struct bat_fake_cap_range range; // 电量范围
    int target_cap;                 // 目标锁定电量
    int policy_enable;              // 策略使能开关
    int func_type;                  // 功能类型（INIT/NOTIFY）
    bool (*func)(void);             // 检测函数
};
```

**预定义策略：**

| 索引 | 源 | 电量范围 | 锁定值 | 触发条件 | 说明 |
|------|---|---------|--------|---------|------|
| 0 | BAT_MODEL | 0-100% | 0% | 检测到硅基电池 | 防止石墨电池误识别 |
| 1 | ECM_MODE | 0-1% | 1% | ECM 模式触发 | 延长极低功耗模式续航 |

---

## 三、核心算法

### 3.1 电量平滑算法（滑动窗口滤波）

**实现函数：** `bat_ui_capacity_pulling_filter()`

**算法原理：**

```c
滑动窗口数组：capacity_filter[10]
当前和：capacity_sum

步骤：
1. 移除最旧的值：capacity_sum -= capacity_filter[index]
2. 插入新值：capacity_filter[index] = curr_capacity
3. 更新总和：capacity_sum += capacity_filter[index]
4. 返回平均值：capacity_sum / filter_len
```

**示例：**

| 步骤 | 输入 SOC | 滤波器数组 | 总和 | 输出 UI SOC |
|------|---------|-----------|------|------------|
| 初始化 | 50 | [50,50,50,50,50,50,50,50,50,50] | 500 | 50 |
| 更新 1 | 52 | [52,50,50,50,50,50,50,50,50,50] | 502 | 50 |
| 更新 2 | 54 | [52,54,50,50,50,50,50,50,50,50] | 504 | 50 |
| ...更新 5 次... | 60 | [52,54,56,56,58,60,50,50,50,50] | 536 | 53 |

**设计目的：** 防止库仑计瞬时波动导致的 UI 电量跳变，提供平滑的用户体验。

### 3.2 SOC 缩放算法

**公式：**

```c
ui_capacity = (raw_soc × 100) / soc_at_term - ui_cap_zero_offset
```

**参数说明：**
- `raw_soc`: 库仑计原始 SOC（0-100%）
- `soc_at_term`: 充电终止时的 SOC（如老化电池可能只能充到 95%）
- `ui_cap_zero_offset`: UI 零点偏移（用于补偿库仑计零点漂移）

**示例 1（电池老化）：**

| 参数 | 值 |
|------|---|
| raw_soc | 95 |
| soc_at_term | 95 |
| ui_cap_zero_offset | 0 |
| **ui_capacity** | **100** |

**示例 2（零点漂移补偿）：**

| 参数 | 值 |
|------|---|
| raw_soc | 5 |
| soc_at_term | 100 |
| ui_cap_zero_offset | 2 |
| **ui_capacity** | **3** |

### 3.3 充电状态检查算法 `bat_ui_capacity_charge_status_check()`

#### 3.3.1 充电中（CHARGING）

**强制满电逻辑：**

```c
if (curr_capacity > 95) {
    chg_force_full_count++;
    if (chg_force_full_count >= chg_force_full_wait_time) {
        // 等待 24 分钟后强制切换到 100%
        curr_capacity = 100;
    }
}
```

**设计理念：** 避免长时间停留在 99%，提升用户体验（默认 24 分钟）。

#### 3.3.2 满电（FULL）

```c
if (bat_volt >= bat_max_volt - 150mV) {
    curr_capacity = 100;  // 强制显示 100%
}
```

**设计理念：** 充电器报告满电后，只要电压未掉到再充电阈值，持续显示 100%。

#### 3.3.3 放电中（DISCHARGING/NOT_CHARGING）

```c
if (ui_prev_capacity <= curr_capacity) {
    return -EPERM;  // 拒绝更新，放电时电量不能上升
}
```

### 3.4 电压阈值校正算法 `bat_ui_capacity_vth_correct_soc()`

**校正流程：**

```c
输入：curr_capacity, bat_volt
配置：vth_soc_calibration_data[] = {
    { soc: 15, volt: 3500 },  // 电压 ≥ 3500mV 时，SOC 锁定到 15%
    { soc: 5, volt: 3450 }    // 电压 ≥ 3450mV 时，SOC 锁定到 5%
}

for (i = 0; i < 2; i++) {
    if ((curr_capacity < vth_soc_calibration_data[i].soc) &&
        (bat_volt >= vth_soc_calibration_data[i].volt)) {
        return vth_soc_calibration_data[i].soc;  // 校正电量
    }
}
return curr_capacity;  // 无需校正
```

**示例场景：**

| 原始 SOC | 电池电压 | 校正后 SOC | 说明 |
|---------|---------|-----------|------|
| 3% | 3460mV | 5% | 电压 ≥ 3450mV，锁定到 5% |
| 12% | 3520mV | 15% | 电压 ≥ 3500mV，锁定到 15% |
| 18% | 3520mV | 18% | SOC 已高于阈值，无需校正 |

**应用场景：** 防止虚电（电池阻抗大、温度低等导致电压虚高）。

### 3.5 关机电量校正算法 `bat_ui_capacity_correct_shutdown_soc_by_vth()`

**校正条件：**

```c
1. 使能开关：correct_shutdown_soc_en = 1
2. 放电状态：DISCHARGING 或 NOT_CHARGING
3. 温度范围：0°C ≤ bat_temp < 50°C
4. 电量区间：shutdown_cap < cap ≤ shutdown_cap + shutdown_gap
   （默认：1% < cap ≤ 3%）
5. 电压检测：bat_volt ≤ shutdown_vth（通过 OCV 表查询 1% 电压）
```

**校正流程：**

```c
if (满足上述条件) {
    // 连续 3 次采样验证电压
    count = 3;
    while (count > 0) {
        voltage = coul_interface_get_battery_voltage();
        if (voltage > shutdown_vth)
            break;  // 电压恢复，取消校正
        count--;
        msleep(1000);
    }
    
    if (count == 0) {
        // 3 次均低于阈值，校正到 shutdown_cap
        return shutdown_cap;
    }
}
```

**设计目的：** 防止库仑计 SOC 报 2-3% 但电压已低于关机阈值，导致意外关机。

### 3.6 假电量过滤算法 `bat_fake_cap_filter()`

**过滤逻辑：**

```c
输入：cap
输出：min(所有生效策略的 target_cap, cap)

示例：
策略 0（硅基电池）：range [0,100]，target=0，enabled=true
策略 1（ECM 模式）：range [0,1]，target=1，enabled=true

case 1: cap=50
  → 策略 0 生效（50 在 [0,100]），target=0
  → 策略 1 不生效（50 不在 [0,1]）
  → 返回 min(0, 50) = 0

case 2: cap=1（ECM 模式下）
  → 策略 0 生效，target=0
  → 策略 1 生效，target=1
  → 返回 min(0, 1, 1) = 0（硅基电池优先级更高）
```

**应用场景：**
1. **硅基电池检测：** 检测到石墨电池被误识别为硅基电池时，强制显示 0%，提醒用户更换
2. **ECM 模式：** 极低功耗模式下，锁定电量到 1%，延长续航时间

---

## 四、SOC 异常监控机制

### 4.1 监控流程 `bat_ui_check_soc_vary_err()`

**触发条件：**

```c
1. 监控间隔：每 60 秒检测一次
2. 温度条件：10°C ≤ bat_temp < 45°C（确保温度稳定）
3. 电量区间：10% < SOC < 90%（避免边界干扰）
4. SOC 变化：|delta_soc| ≥ soc_monitor_limit（默认 15%）
```

**DSM 上报内容：**

```c
gauge_name: maxim_ds28e30
start: ui_soc=85, raw_soc=88, volt=4100, cur=-500, temp=250
end: ui_soc=68, raw_soc=70, volt=3900, cur=-800, temp=248
delta_soc=-17, soc_monitor_limit=15
```

**典型故障原因：**
- 库仑计校准失败
- 电池内阻突变（老化/损坏）
- OCV 表不匹配
- 温度传感器异常

---

## 五、工作流程

### 5.1 初始化流程

```
probe()
  ├─ 解析 DTS 参数
  │   ├─ soc_at_term（SOC 缩放因子）
  │   ├─ filter_len（滤波器长度）
  │   ├─ vth_correct_para（电压校正参数）
  │   ├─ shutdown_correct_para（关机校正参数）
  │   └─ monitoring_interval（监控间隔）
  │
  ├─ 初始化数据
  │   ├─ charge_status = DISCHARGING
  │   ├─ chg_force_full_wait_time = 24 分钟
  │   └─ ui_capacity = -1（未初始化标志）
  │
  ├─ 注册充电事件通知
  │
  ├─ 启动等待工作队列（wait_work）
  │   └─ 等待库仑计就绪（最多 120 秒）
  │
  └─ 二次初始化
      ├─ 读取上次关机电量（last_capacity）
      ├─ 比较当前电量（curr_capacity）
      ├─ 若跳变 < 7%，使用 last_capacity
      ├─ 初始化滑动窗口滤波器
      └─ 启动更新工作队列（update_work）
```

### 5.2 更新工作队列 `bat_ui_capacity_work()`

```
每 5-10 秒执行一次：

1. 获取 wakelock（防止休眠）
2. 更新电池信息
   ├─ bat_exist（电池存在性）
   ├─ bat_volt（电压）
   ├─ bat_cur（电流）
   └─ bat_temp（温度）
3. 读取库仑计 SOC
4. SOC 缩放处理
   └─ ui_cap = (raw_soc × 100) / soc_at_term - offset
5. 充电状态检查
   ├─ 充电中：强制满电计时器
   ├─ 满电：电压保持 100%
   └─ 放电：单向递减检查
6. 电压阈值校正
7. 关机电量校正
8. 滑动窗口滤波
9. 假电量过滤
10. 异常检查
    ├─ 放电时 SOC 不能上升
    └─ 充电时 SOC 不能下降（直流充电除外）
11. 更新 UI 电量
    ├─ ui_capacity = 平滑后的 SOC
    └─ power_supply_changed("Battery")
12. SOC 异常监控（每 60s）
13. 释放 wakelock
14. 调整监控间隔
    ├─ 充电中：5 秒
    ├─ 低温（< -5°C）：5 秒
    └─ 正常放电：10 秒
15. 重新调度工作队列
```

---

## 六、DTS 配置

### 6.1 主配置示例

```dts
battery_ui_capacity {
    compatible = "huawei,battery_ui_capacity";
    
    /* SOC 缩放参数 */
    soc_at_term = <100>;         // 充电终止 SOC（老化电池可能 < 100）
    ui_cap_zero_offset = <0>;    // UI 零点偏移（%）
    
    /* 滑动窗口滤波器 */
    filter_len = <10>;           // 滤波器长度（1-10）
    
    /* 监控间隔 */
    monitoring_interval_normal = <10000>;     // 正常模式 10s
    monitoring_interval_charging = <5000>;    // 充电模式 5s
    monitoring_interval_lowtemp = <5000>;     // 低温模式 5s
    
    /* SOC 异常监控 */
    soc_monitor_limit = <15>;    // SOC 变化阈值 15%
    cap_jump_th = <7>;           // 开机电量跳变阈值 7%
    
    /* 电压阈值校正 */
    vth_correct_en = <1>;
    vth_correct_para = <
        15 3500    // SOC<15% 且 V≥3500mV → 锁定 15%
        5  3450    // SOC<5% 且 V≥3450mV → 锁定 5%
    >;
    
    /* 关机电量校正 */
    correct_shutdown_soc_en = <1>;
    shutdown_cap = <1>;          // 关机电量下限 1%
    shutdown_gap = <2>;          // 校正区间 [1%, 3%]
    shutdown_vth = <3380>;       // 关机电压阈值 3380mV
    
    /* 等待超时 */
    wait_max_time = <120000>;    // 等待库仑计就绪最大 120s
};
```

### 6.2 假电量过滤配置

```dts
battery_fake_cap {
    compatible = "huawei,battery_fake_cap";
    
    /* 支持的假电量源 */
    fake_src_support = <0 1>;
    // 0: BAT_FAKE_CAP_SRC_BAT_MODEL（硅基电池检测）
    // 1: BAT_FAKE_CAP_SRC_ECM_MODE（ECM 模式）
    
    /* 延迟启动时间（等待电池信息就绪） */
    start_work_wait_time = <5000>;  // 5 秒
};
```

---

## 七、外部接口

### 7.1 获取 UI 电量 `bat_ui_capacity()`

```c
int bat_ui_capacity(void);
```

**返回值：** UI 电量百分比（0-100%），经过所有过滤和平滑处理。

**调用路径：**
```
Android Framework
    ↓
power_supply.capacity (sysfs)
    ↓
battery_core.c
    ↓
bat_ui_capacity()
    ↓
bat_fake_cap_filter()  // 假电量过滤
```

### 7.2 获取原始电量 `bat_ui_raw_capacity()`

```c
int bat_ui_raw_capacity(void);
```

**返回值：** 原始电量（库仑计直接输出），仅经过假电量过滤，未经过平滑和校正。

**用途：** 调试、日志记录。

### 7.3 同步滤波器 `bat_ui_capacity_sync_filter()`

```c
void bat_ui_capacity_sync_filter(int rep_soc, int round_soc, int base);
```

**功能：** 外部强制同步滑动窗口滤波器（如充电器主动上报电量）。

**参数：**
- `rep_soc`: 上报的 SOC（基于 base 缩放）
- `round_soc`: 四舍五入后的 SOC
- `base`: 缩放基数（如 1000 表示 rep_soc 是千分比）

---

## 八、充电事件处理

### 8.1 事件通知回调 `bat_ui_capacity_event_notifier_call()`

| 事件 | 处理 |
|------|------|
| `POWER_NE_CHARGING_START` | charge_status = CHARGING |
| `POWER_NE_CHARGING_STOP` | charge_status = DISCHARGING |
| `POWER_NE_CHARGING_SUSPEND` | charge_status = NOT_CHARGING |

**附加动作：**
- 复位 SOC 监控计数器
- 设置监控标志为 `BUC_STATUS_START`
- 更新充电状态

---

## 九、电源管理

### 9.1 Suspend/Resume

```c
suspend():
    cancel_delayed_work(&update_work)  // 取消工作队列，省电

resume():
    soc_monitor_flag = BUC_STATUS_WAKEUP
    queue_delayed_work(&update_work, 0)  // 立即更新电量
```

### 9.2 Shutdown/Reboot

```c
shutdown() / reboot_notifier_call():
    保存当前 UI 电量到库仑计
    ↓
    coul_interface_set_battery_last_capacity(ui_capacity)
```

**用途：** 下次开机时，若电量跳变 < 7%，则使用上次保存值，避免开机电量突变。

---

## 十、调试技巧

### 10.1 查看实时 UI 电量

```bash
cat /sys/class/power_supply/Battery/capacity
```

### 10.2 查看原始库仑计 SOC

```bash
# 通过 debugfs（需要 coul 驱动支持）
cat /sys/kernel/debug/coul/raw_soc
```

### 10.3 模拟强制满电

修改 battery_ui_capacity.c 中的等待时间：

```c
// 原代码：24 分钟
di->chg_force_full_wait_time = BUC_CHG_FORCE_FULL_TIME * 60 * 1000 / di->interval_charging;

// 调试代码：30 秒
di->chg_force_full_wait_time = 30 * 1000 / di->interval_charging;
```

### 10.4 监控 SOC 变化

在 battery_ui_capacity.c 中添加日志：

```c
hwlog_info("SOC Update: raw=%d, scaled=%d, filtered=%d, vth_corrected=%d, fake_filtered=%d\n",
    raw_soc, scaled_soc, filtered_soc, vth_corrected_soc, final_soc);
```

### 10.5 验证电压校正

```bash
dmesg | grep "correct capacity"
```

输出示例：
```
bat_ui_capacity: correct capacity: bat_vol=3520,cap=12,lock_cap=15
```

### 10.6 查看 DSM 告警

```bash
dmesg | grep "soc vary fast"
```

输出示例：
```
bat_ui_capacity: soc vary fast! soc_changed is -17
maxim_ds28e30, soc r_soc vol cur temp start:85,88,4100,-500,250 
end: 68,70,3900,-800,248 delta_soc=-17,soc_monitor_limit=15
```

### 10.7 手动触发假电量过滤

```c
// 在 ECM 模式触发时
power_event_bnc_notify(POWER_BNT_LOW_POWER, 
    POWER_NE_BAT_ECM_TRIGGER_STATUS, &ecm_status);
```

---

## 十一、关键宏定义

```c
#define BUC_WINDOW_LEN                      10      // 滑动窗口长度
#define BUC_VBAT_MIN                        3450    // 最低电压（mV）
#define BUC_CAPACITY_FULL                   100     // 满电电量
#define BUC_SOC_JUMP_THRESHOLD              2       // SOC 跳变阈值
#define BUC_CURRENT_THRESHOLD               10      // 电流阈值（mA）
#define BUC_LOWTEMP_THRESHOLD               (-50)   // 低温阈值（-5°C）
#define BUC_WORK_INTERVAL_NORMAL            10000   // 正常监控间隔（10s）
#define BUC_WORK_INTERVAL_CHARGING          5000    // 充电监控间隔（5s）
#define BUC_CHG_FORCE_FULL_SOC_THRESHOLD    95      // 强制满电阈值
#define BUC_CHG_FORCE_FULL_TIME             24      // 强制满电时间（分钟）
#define BUC_WAIT_MAX_TIME                   120000  // 等待库仑计超时（120s）
#define BUC_SOC_MONITOR_INTERVAL            60000   // SOC 监控间隔（60s）
#define BUC_DEFAULT_SOC_MONITOR_LIMIT       15      // SOC 变化限制（15%）
#define BUC_CAP_JUMP_TH                     7       // 开机电量跳变阈值（7%）
```

---

## 十二、典型场景分析

### 12.1 场景 1：充电到 95% 后长时间不变

**现象：** 用户反馈充电到 95% 后，24 分钟才跳到 100%。

**原因分析：**
- 触发强制满电机制（`chg_force_full_soc_thld=95`）
- 默认等待时间：24 分钟

**优化方案：**
```dts
// 修改 DTS，缩短强制满电时间到 10 分钟
// chg_force_full_wait_time = 10 × 60 × 1000 / 5000 = 120 次
```

或在代码中调整：
```c
#define BUC_CHG_FORCE_FULL_TIME  10  // 改为 10 分钟
```

### 12.2 场景 2：低电量时突然关机

**现象：** 电量显示 3% 时意外关机。

**原因分析：**
- 库仑计 SOC 报 3%，但实际电压已低于关机阈值（3380mV）
- 关机电量校正功能可能未使能

**解决方案：**
```dts
battery_ui_capacity {
    correct_shutdown_soc_en = <1>;  // 使能关机校正
    shutdown_cap = <1>;
    shutdown_gap = <2>;             // 在 [1%, 3%] 区间校正
    shutdown_vth = <3380>;
};
```

### 12.3 场景 3：电量跳变异常

**现象：** 电量从 85% 突然跳到 68%。

**调试步骤：**

1. 查看 DSM 日志：
```bash
dmesg | grep "soc vary fast"
```

2. 分析跳变原因：
   - 电池老化导致内阻增大
   - 温度变化导致 OCV 偏移
   - 库仑计校准失败

3. 调整监控阈值（临时措施）：
```dts
soc_monitor_limit = <20>;  // 提高到 20%
```

### 12.4 场景 4：硅基电池误识别

**现象：** 石墨电池被识别为硅基电池，电量始终显示 0%。

**原因分析：**
- `bat_model_match_graphite_battery()` 返回 `false`
- 触发假电量策略 0（BAT_FAKE_CAP_SRC_BAT_MODEL）

**解决方案：**

检查电池型号识别逻辑：
```c
// battery_model.c 中
bool bat_model_match_graphite_battery(void)
{
    // 检查电池 ID、OCV 曲线等
    // 返回 true 表示确定是石墨电池
}
```

### 12.5 场景 5：ECM 模式电量锁定

**现象：** 进入 ECM（极低功耗）模式后，电量锁定在 1%。

**工作流程：**
```
Low Power 模块检测到 ECM 触发
    ↓
power_event_bnc_notify(POWER_BNT_LOW_POWER, 
    POWER_NE_BAT_ECM_TRIGGER_STATUS, ECM_TRIGGER_CN)
    ↓
bat_fake_cap_lpm_notifier_call()
    ↓
g_bat_fake_cap_array[BAT_FAKE_CAP_SRC_ECM_MODE].policy_enable = ON
    ↓
bat_fake_cap_filter(cap) → 若 cap ∈ [0,1]，锁定到 1%
```

---

## 十三、总结

`battery_ui_capacity` 模块通过**多级过滤算法**和**智能状态机**，将库仑计的原始 SOC 转换为用户友好的 UI 电量。核心亮点包括：

1. **滑动窗口平滑：** 10 点移动平均，消除瞬时波动
2. **充电状态感知：** 充电/放电/满电下的不同处理逻辑
3. **电压二次校验：** 通过 OCV 表防止虚电和意外关机
4. **假电量框架：** 支持硅基电池检测、ECM 模式等特殊场景
5. **异常监控上报：** DSM 机制及时发现 SOC 异常变化
6. **开机电量保护：** 保存关机电量，避免重启跳变
7. **温度自适应：** 低温下提高监控频率，确保准确性

该模块是华为电池管理系统的核心组件，直接影响用户电量显示体验和关机保护可靠性，广泛应用于旗舰手机、平板和折叠屏设备中。