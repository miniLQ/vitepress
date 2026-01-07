---
outline: deep
---

# Battery Heating 模块分析

## 1. 模块定位与核心价值

bat_heating 是华为充电管理系统中的 **低温电池加热控制模块**，用于在低温环境下通过充电电流给电池加热，提升低温充电性能和用户体验。

**核心价值：**
- ❄️ **低温保护**：低温环境下自动启动电池加热
- 🔥 **智能加热**：根据温度动态调整充电电流
- 🛡️ **安全控制**：多重条件检查，防止过热和误触发
- 📊 **数据采集**：NV 存储加热次数，DMD 异常上报

## 2. 系统架构

### 2.1 整体架构

```
┌─────────────────────────────────────────────────────────────┐
│                  用户空间/守护进程                             │
│              (bms_heating daemon)                            │
└──────────────────────┬──────────────────────────────────────┘
                       │ sysfs
          ┌────────────┴────────────┐
          │                         │
          ▼                         ▼
    trigger (触发加热)          count (加热次数)
    retrigger (重新触发)        heat_up (加热状态)
          │                         │
          └────────────┬────────────┘
                       ▼
┌─────────────────────────────────────────────────────────────┐
│                  bat_heating.c (核心逻辑)                     │
├─────────────────────────────────────────────────────────────┤
│ 监控工作队列 (5s 周期)                                        │
│ ├─ 充电器类型检查                                            │
│ ├─ USB 连接状态检查                                          │
│ ├─ SOC 检查 (< 99%)                                         │
│ ├─ 电流检查 (> -400mA)                                      │
│ └─ 温度检查 (-10℃ ~ 40℃)                                    │
│                                                             │
│ 加热控制                                                     │
│ ├─ BUCK 模式 (t < 10℃): 限制充电电流                        │
│ └─ 直充模式 (t ≥ 10℃): 限制输入电流                         │
└──────────────────────┬──────────────────────────────────────┘
                       │
        ┌──────────────┼──────────────┐
        ▼              ▼              ▼
   Notifier       Uevent/UI       NV Storage
   ┌──────────┐  ┌──────────┐  ┌──────────┐
   │ Charging │  │ HEATING_ │  │ 加热次数 │
   │ Start/   │  │ START=   │  │ 持久化   │
   │ Stop     │  │ HEATING_ │  │ 存储     │
   │          │  │ STOP=    │  │          │
   │ DC Path  │  │ HEATING_ │  └──────────┘
   │ Switch   │  │ EXIT=    │
   │          │  │          │
   │ Screen   │  │ UI Popup │
   │ On/Off   │  │ Message  │
   └──────────┘  └──────────┘
```

### 2.2 加热原理

**物理原理：** 通过增大充电电流，利用电池内阻产生的焦耳热 ($Q = I^2 \times R \times t$) 给电池加热

**温度分段控制：**

```
温度 (℃)
│
│  40 ┼────────────────────────────────► (停止加热)
│     │
│  10 ┼──────┐                           (切换点)
│     │ BUCK │ 直充模式 (LVC/SC/SC4)
│     │ 模式 │ 限制输入电流
│     │      │
│ -10 ┼──────┴─────────────────────────► (启动加热)
│     │ 
       低温阈值           高温阈值 + 滞后
```

## 3. 核心数据结构

### 3.1 设备结构

```c
struct bat_heating_dev {
    struct device *dev;                        // 设备指针
    struct notifier_block nb;                  // 充电事件通知
    struct notifier_block fb_nb;               // 屏幕事件通知
    struct notifier_block dc_nb;               // 直充事件通知
    
    /* 工作队列 */
    struct delayed_work monitor_work;          // 监控工作 (5s 周期)
    struct delayed_work rd_count_work;         // 读 NV 次数
    struct delayed_work wr_count_work;         // 写 NV 次数
    struct delayed_work rpt_dmd_work;          // DMD 上报
    
    /* 状态标志 */
    int dmd_count;                             // DMD 上报计数
    int hysteresis;                            // 温度滞后值
    int count;                                 // 加热总次数 (NV)
    int trigger;                               // 触发标志
    int retrigger;                             // 重新触发标志
    int bat_temp;                              // 电池温度 (℃)
    int usb_temp;                              // USB 温度 (℃)
    int usb_state;                             // USB 连接状态
    int screen_state;                          // 屏幕状态
    
    /* DTS 配置参数 */
    int low_temp_min_thld;                     // 低温最小阈值 (默认 -10℃)
    int low_temp_max_thld;                     // 低温最大阈值 (默认 5℃)
    int low_temp_hysteresis;                   // 温度滞后 (默认 35℃)
    int low_temp_min_ibat;                     // 最小充电电流 (默认 -400mA)
    int buck_iin_limit;                        // BUCK 输入限流 (默认 1300mA)
    
    /* 温度-电流映射表 (最多 8 档) */
    struct bat_heating_temp_para temp_para[BAT_HEATING_TEMP_LEVEL];
    
    /* 运行时标志 */
    bool heat_up_flag;                         // 正在加热标志
    bool ui_msg_flag;                          // UI 消息已显示
    bool dc_stop_flag;                         // 直充切换临时停止
    int overload_count;                        // 过载计数
    bool service_exit_flag;                    // 服务退出标志
};
```

### 3.2 温度参数结构

```c
struct bat_heating_temp_para {
    int temp_min;      // 温度下限 (℃)
    int temp_max;      // 温度上限 (℃)
    int temp_ichg;     // 对应充电电流 (mA)
};
```

### 3.3 状态枚举

```c
/* USB 连接状态 */
enum bat_heating_usb_state {
    BAT_HEATING_USB_DISCONNECT,   // 未连接
    BAT_HEATING_USB_CONNECT,      // 已连接
};

/* 屏幕状态 */
enum bat_heating_screen_state {
    BAT_HEATING_SCREEN_ON,        // 亮屏
    BAT_HEATING_SCREEN_OFF,       // 息屏
};

/* Uevent 类型 */
enum bat_heating_uevent_type {
    BAT_HEATING_START_HEAT_UP,    // 开始加热
    BAT_HEATING_STOP_HEAT_UP,     // 停止加热
    BAT_HEATING_POPUP_UI_MSG,     // 弹出 UI 提示
    BAT_HEATING_REMOVE_UI_MSG,    // 移除 UI 提示
    BAT_HEATING_EXIT_SERVICE,     // 退出服务
};
```

## 4. 核心流程实现

### 4.1 完整加热流程

```
┌─────────────────────────────────────────────────────────────┐
│ 1. 充电器插入事件                                            │
│    POWER_NE_CHARGING_START → bat_heating_start()             │
└────────────────────┬────────────────────────────────────────┘
                     ▼
┌─────────────────────────────────────────────────────────────┐
│ 2. 启动监控工作队列                                          │
│    延迟 15s 后启动 → schedule_delayed_work(monitor_work)     │
└────────────────────┬────────────────────────────────────────┘
                     ▼
┌─────────────────────────────────────────────────────────────┐
│ 3. 多重条件检查 (每 5s 执行一次)                             │
│    ① 充电器类型检查 (非 DCP/FCP/SCP/PD 退出)                │
│    ② USB 状态检查 (未连接退出)                               │
│    ③ SOC 检查 (≥ 99% 退出)                                  │
│    ④ 电流检查 (< -400mA 超过 20 次退出)                     │
│    ⑤ 温度检查:                                               │
│       • bat_temp vs usb_temp 差值 ≥ 15℃ → 退出             │
│       • bat_temp 不在 [-10, 40] 范围 → 退出                │
└────────────────────┬────────────────────────────────────────┘
                     ▼
             ┌───────┴──────┐
             │ 检查是否通过 │
             └───┬──────┬───┘
         失败 ▼      ▼ 成功
    ┌──────────┐  ┌──────────────────────────────┐
    │ 退出服务 │  │ 4. 屏幕状态判断              │
    │ EXIT=    │  └────────┬─────────────────────┘
    └──────────┘           │
                    ┌──────┴──────┐
                    │ screen_state │
                    └──┬──────┬───┘
              亮屏 ▼      ▼ 息屏
        ┌──────────┐  ┌──────────────────────────────┐
        │ 停止加热 │  │ 5. 启动加热控制              │
        │ 显示 UI  │  │    • heat_up_flag = true     │
        └──────────┘  │    • 发送 HEATING_START=     │
                      │    • 根据温度选择电流档位     │
                      └────────┬─────────────────────┘
                               ▼
                    ┌────────────────────────┐
                    │ 6. 温度分段控制        │
                    └────┬───────────────────┘
                         │
              ┌──────────┼──────────┐
              ▼                     ▼
    ┌─────────────────┐   ┌─────────────────┐
    │ bat_temp < 10℃  │   │ bat_temp ≥ 10℃ │
    │ BUCK 模式       │   │ 直充模式        │
    ├─────────────────┤   ├─────────────────┤
    │ 限制充电电流    │   │ 限制输入电流    │
    │ BATT_ICHG_LIMIT │   │ LVC/SC/SC4      │
    └─────────────────┘   │ VBUS_IIN_LIMIT  │
                          └─────────────────┘
                               ▼
                    ┌────────────────────────┐
                    │ 7. 循环监控 (每 5s)    │
                    │    持续检查条件        │
                    └────────────────────────┘
```

### 4.2 条件检查详解

#### 4.2.1 充电器类型检查

```c
static bool bat_heating_check_charger_type(struct bat_heating_dev *l_dev)
{
    unsigned int type = charge_get_charger_type();

    // 只支持标准充电器 (DCP/FCP/SCP/PD)
    if ((type == CHARGER_TYPE_STANDARD) ||
        (type == CHARGER_TYPE_FCP) ||
        (type == CHARGER_TYPE_SCP) ||
        (type == CHARGER_TYPE_PD))
        return false;  // 检查通过

    hwlog_info("check: charger_type=%d is invalid\n", type);
    return true;  // 检查失败，退出加热
}
```

**原因：** 非标准充电器（如 USB、无线充电器）输出电流不稳定，不适合加热

#### 4.2.2 屏幕状态检查

```c
static bool bat_heating_check_screen_state(struct bat_heating_dev *l_dev)
{
    if (l_dev->screen_state != BAT_HEATING_SCREEN_ON)
        return false;  // 息屏，可以加热

    hwlog_info("check: screen on\n");
    return true;  // 亮屏，停止加热，显示 UI
}
```

**原因：** 亮屏时用户正在使用手机，大电流充电会影响性能和发热，需要提示用户

#### 4.2.3 USB 连接状态检查

```c
static bool bat_heating_check_usb_state(struct bat_heating_dev *l_dev)
{
    if (l_dev->usb_state != BAT_HEATING_USB_DISCONNECT)
        return false;  // 已连接充电器

    hwlog_info("check: usb is disconnect\n");
    return true;  // 未连接，退出
}
```

#### 4.2.4 SOC 检查

```c
static bool bat_heating_check_soc(struct bat_heating_dev *l_dev)
{
    int soc = power_supply_app_get_bat_capacity();

    if (soc < BAT_HEATING_FULL_SOC)  // 99%
        return false;  // 未充满，继续加热

    hwlog_info("check: soc=%d is invalid\n", soc);
    return true;  // 接近充满，停止加热
}
```

**原因：** 电量充满后继续大电流充电会损害电池寿命

#### 4.2.5 电流检查（过载保护）

```c
static bool bat_heating_check_current(struct bat_heating_dev *l_dev)
{
    int cur = -power_platform_get_battery_current();

    if (cur >= l_dev->low_temp_min_ibat) {  // -400mA
        l_dev->overload_count = 0;
        return false;  // 电流正常
    }

    hwlog_info("check: count=%d current=%d is overload\n",
        l_dev->overload_count, cur);
    
    // 连续 20 次 (100s) 电流过大才判定为过载
    if (l_dev->overload_count++ >= BAT_HEATING_OVERLOAD_THLD)
        return true;  // 过载，退出
    
    return false;
}
```

**过载判定逻辑：**
- 每 5 秒检查一次电流
- 如果电流 < -400mA，计数器 +1
- 连续 20 次（100 秒）过载才触发保护
- 防止瞬时波动导致误判

#### 4.2.6 温度检查

```c
static bool bat_heating_check_temp(struct bat_heating_dev *l_dev)
{
    // 读取温度
    l_dev->usb_temp = power_temp_get_average_value(POWER_TEMP_USB_PORT);
    l_dev->usb_temp /= POWER_MC_PER_C;  // mC → ℃
    l_dev->bat_temp = power_supply_app_get_bat_temp();

    // 检查 1: 电池温度 vs USB 温度差值
    if (abs(l_dev->bat_temp - l_dev->usb_temp) >= BAT_HEATING_USB_TEMP_THLD) {
        hwlog_info("check: usb_temp=%d bat_temp=%d\n",
            l_dev->usb_temp, l_dev->bat_temp);
        return true;  // 温差过大，可能存在异常
    }

    // 检查 2: 电池温度范围
    if ((l_dev->bat_temp < l_dev->low_temp_min_thld) ||
        (l_dev->bat_temp > l_dev->low_temp_max_thld + l_dev->hysteresis)) {
        hwlog_info("check: bat_temp=%d min_thld=%d max_thld=%d\n",
            l_dev->bat_temp,
            l_dev->low_temp_min_thld,
            l_dev->low_temp_max_thld + l_dev->hysteresis);
        return true;  // 超出范围
    }

    return false;  // 温度正常
}
```

**温度滞后机制：**

```
温度 (℃)
│
│  40 ┼──────────────────────────────► (max + hysteresis, 停止)
│     │        滞后区间 (35℃)
│   5 ┼──────────────────────────────► (max, 启动阈值)
│     │
│     │      正常加热区间
│     │
│ -10 ┼──────────────────────────────► (min, 启动阈值)
│
```

**防抖设计：**
- 首次启动：温度在 [-10, 5] 范围内启动
- 运行中：温度达到 40℃ (5 + 35) 才停止
- 避免温度在 5℃ 附近反复启停

### 4.3 充电电流控制

#### 4.3.1 温度-电流映射

```c
static void bat_heating_select_charging_current(struct bat_heating_dev *l_dev)
{
    int i;
    int ichg = 0;

    // 遍历温度表，找到匹配的档位
    for (i = 0; i < BAT_HEATING_TEMP_LEVEL; ++i) {
        if ((l_dev->bat_temp >= l_dev->temp_para[i].temp_min) &&
            (l_dev->bat_temp < l_dev->temp_para[i].temp_max)) {
            ichg = l_dev->temp_para[i].temp_ichg;
            break;
        }
    }

    bat_heating_set_charging_current(l_dev, ichg);
}
```

**DTS 配置示例：**

```dts
temp_para = "-10", "0",  "1000",    /* -10℃ ~ 0℃: 1000mA */
            "0",   "5",  "1500",    /*   0℃ ~ 5℃: 1500mA */
            "5",   "10", "2000",    /*   5℃ ~ 10℃: 2000mA */
            "10",  "15", "2500",    /*  10℃ ~ 15℃: 2500mA */
            "15",  "20", "3000";    /*  15℃ ~ 20℃: 3000mA */
```

#### 4.3.2 分模式电流控制

```c
static void bat_heating_set_charging_current(struct bat_heating_dev *l_dev,
    int cur)
{
    // 特殊值处理
    if (cur == -1) {
        // 限制 BUCK 输入电流（防止过热）
        power_if_kernel_sysfs_set(POWER_IF_OP_TYPE_DCP,
            POWER_IF_SYSFS_VBUS_IIN_LIMIT, l_dev->buck_iin_limit);
        return;
    }

    // 清零限制
    power_if_kernel_sysfs_set(POWER_IF_OP_TYPE_DCP,
        POWER_IF_SYSFS_VBUS_IIN_LIMIT, 0);
    power_if_kernel_sysfs_set(POWER_IF_OP_TYPE_DCP,
        POWER_IF_SYSFS_BATT_ICHG_LIMIT, 0);

    // 恢复默认电流
    if (cur == 0) {
        power_if_kernel_sysfs_set(POWER_IF_OP_TYPE_LVC,
            POWER_IF_SYSFS_VBUS_IIN_LIMIT, 0);
        power_if_kernel_sysfs_set(POWER_IF_OP_TYPE_SC,
            POWER_IF_SYSFS_VBUS_IIN_LIMIT, 0);
        power_if_kernel_sysfs_set(POWER_IF_OP_TYPE_SC4,
            POWER_IF_SYSFS_VBUS_IIN_LIMIT, 0);
        return;
    }

    // 根据温度选择控制方式
    if (l_dev->bat_temp >= BAT_HEATING_DC_TEMP_THLD) {
        // 温度 ≥ 10℃: 直充模式，限制输入电流
        power_if_kernel_sysfs_set(POWER_IF_OP_TYPE_LVC,
            POWER_IF_SYSFS_VBUS_IIN_LIMIT, cur);
        power_if_kernel_sysfs_set(POWER_IF_OP_TYPE_SC,
            POWER_IF_SYSFS_VBUS_IIN_LIMIT, cur);
        power_if_kernel_sysfs_set(POWER_IF_OP_TYPE_SC4,
            POWER_IF_SYSFS_VBUS_IIN_LIMIT, cur);
    } else {
        // 温度 < 10℃: BUCK 模式，限制充电电流
        power_if_kernel_sysfs_set(POWER_IF_OP_TYPE_DCP,
            POWER_IF_SYSFS_BATT_ICHG_LIMIT, cur);
    }
}
```

**控制模式选择：**

| 温度范围 | 充电模式 | 控制方式 | 原因 |
|---------|---------|---------|------|
| < 10℃ | BUCK | 限制充电电流 | 低温下直充可能不稳定 |
| ≥ 10℃ | LVC/SC/SC4 | 限制输入电流 | 直充效率高，加热效果好 |

### 4.4 Uevent 通知机制

```c
static void bat_heating_send_uevent(struct bat_heating_dev *l_dev, int type)
{
    struct power_event_notify_data n_data;
    int value;

    switch (type) {
    case BAT_HEATING_START_HEAT_UP:
        if (l_dev->heat_up_flag && !l_dev->retrigger)
            return;  // 已在加热且未重新触发，忽略
        l_dev->retrigger = 0;
        l_dev->heat_up_flag = true;
        n_data.event = "HEATING_START=";
        n_data.event_len = 14;
        power_event_report_uevent(&n_data);
        break;
        
    case BAT_HEATING_STOP_HEAT_UP:
        if (!l_dev->heat_up_flag)
            return;  // 未在加热，忽略
        l_dev->retrigger = 0;
        l_dev->heat_up_flag = false;
        n_data.event = "HEATING_STOP=";
        n_data.event_len = 13;
        power_event_report_uevent(&n_data);
        break;
        
    case BAT_HEATING_POPUP_UI_MSG:
        if (l_dev->ui_msg_flag)
            return;  // UI 已显示，忽略
        l_dev->ui_msg_flag = true;
        value = 1;  // 1: popup
        power_ui_event_notify(POWER_UI_NE_HEATING_STATUS, &value);
        break;
        
    case BAT_HEATING_REMOVE_UI_MSG:
        if (!l_dev->ui_msg_flag)
            return;  // UI 未显示，忽略
        value = 0;  // 0: remove
        power_ui_event_notify(POWER_UI_NE_HEATING_STATUS, &value);
        break;
        
    case BAT_HEATING_EXIT_SERVICE:
        l_dev->service_exit_flag = true;
        n_data.event = "HEATING_EXIT=";
        n_data.event_len = 13;
        power_event_report_uevent(&n_data);
        break;
    }
}
```

**Uevent 消息列表：**

| Uevent | 含义 | 接收者 |
|--------|------|--------|
| HEATING_START= | 开始加热 | bms_heating daemon |
| HEATING_STOP= | 停止加热 | bms_heating daemon |
| HEATING_EXIT= | 退出服务 | bms_heating daemon |
| POWER_UI_NE_HEATING_STATUS | UI 提示 | SystemUI |

## 5. 事件通知处理

### 5.1 充电事件

```c
static int bat_heating_notifier_call(struct notifier_block *nb,
    unsigned long event, void *data)
{
    struct bat_heating_dev *l_dev = bat_heating_get_dev();

    switch (event) {
    case POWER_NE_CHARGING_STOP:
        bat_heating_stop(l_dev);  // 充电停止，退出加热
        break;
    case POWER_NE_CHARGING_START:
        bat_heating_start(l_dev);  // 充电启动，延迟 15s 启动监控
        break;
    }

    return NOTIFY_OK;
}
```

### 5.2 屏幕事件

```c
static int bat_heating_fb_notifier_call(struct notifier_block *nb,
    unsigned long event, void *data)
{
    struct bat_heating_dev *l_dev = bat_heating_get_dev();

    switch (event) {
    case POWER_NE_PANEL_BLANK:
        l_dev->screen_state = BAT_HEATING_SCREEN_OFF;  // 息屏
        hwlog_info("fb screen off\n");
        break;
    case POWER_NE_PANEL_UNBLANK:
        l_dev->screen_state = BAT_HEATING_SCREEN_ON;   // 亮屏
        hwlog_info("fb screen on\n");
        break;
    }

    return NOTIFY_OK;
}
```

**息屏/亮屏处理：**
- **息屏**：允许加热，发送 `HEATING_START=`
- **亮屏**：停止加热，弹出 UI 提示用户"正在加热，请勿使用手机"

### 5.3 直充路径切换事件

```c
static int bat_heating_dc_status_notifier_call(struct notifier_block *nb,
    unsigned long event, void *data)
{
    struct bat_heating_dev *l_dev = bat_heating_get_dev();

    switch (event) {
    case POWER_NE_DC_SWITCH_PATH:
        // 直充路径切换中，暂停加热
        if (l_dev->trigger && l_dev->heat_up_flag) {
            bat_heating_send_uevent(l_dev, BAT_HEATING_STOP_HEAT_UP);
            l_dev->dc_stop_flag = true;
        }
        break;
        
    case POWER_NE_DC_CHECK_SUCC:
        // 直充切换成功，恢复加热
        if (l_dev->trigger && l_dev->dc_stop_flag) {
            bat_heating_send_uevent(l_dev, BAT_HEATING_START_HEAT_UP);
            l_dev->dc_stop_flag = false;
        }
        break;
        
    case POWER_NE_DC_STOP_CHARGE:
        // 直充失败，恢复加热
        if (l_dev->trigger && l_dev->dc_stop_flag) {
            bat_heating_send_uevent(l_dev, BAT_HEATING_START_HEAT_UP);
            l_dev->dc_stop_flag = false;
        }
        break;
    }

    return NOTIFY_OK;
}
```

**直充切换保护：**
- 直充路径切换时会短暂断开充电
- 暂停加热避免电流控制冲突
- 切换完成后自动恢复

## 6. Sysfs 接口

### 6.1 接口列表

```bash
# 电池加热 sysfs 节点路径
/sys/class/hw_power/bat_heating/
├── count       # 读写，加热总次数（NV 存储）
├── trigger     # 读写，触发加热标志
├── retrigger   # 读写，重新触发标志
└── heat_up     # 只读，当前加热状态
```

### 6.2 接口详解

#### 6.2.1 count（加热次数）

**读操作：**
```bash
cat /sys/class/hw_power/bat_heating/count
# 输出：15  （已加热 15 次）
```

**写操作：**
```bash
echo "bms_heating 20" > /sys/class/hw_power/bat_heating/count
# 格式：<user> <value>
# user: shell / bms_heating
```

**持久化：** 写入后自动保存到 NV（非易失性存储）

#### 6.2.2 trigger（触发标志）

**读操作：**
```bash
cat /sys/class/hw_power/bat_heating/trigger
# 输出：0 (未触发) / 1 (已触发)
```

**写操作：**
```bash
echo "bms_heating 1" > /sys/class/hw_power/bat_heating/trigger
```

**作用：**
- 由 `bms_heating` 守护进程设置
- 触发后启用温度-电流映射控制
- 同时触发 DMD 上报

#### 6.2.3 retrigger（重新触发）

**写操作：**
```bash
echo "bms_heating 1" > /sys/class/hw_power/bat_heating/retrigger
```

**作用：** 强制重新发送 `HEATING_START=` uevent

#### 6.2.4 heat_up（加热状态，只读）

**读操作：**
```bash
cat /sys/class/hw_power/bat_heating/heat_up
# 输出：0 (未加热) / 1 (正在加热)
```

## 7. NV 存储与 DMD 上报

### 7.1 NV 存储（加热次数）

```c
// 读取加热次数（启动后 10s）
static void bat_heating_read_count_work(struct work_struct *work)
{
    struct bat_heating_dev *l_dev = bat_heating_get_dev();
    
    (void)power_nv_read(POWER_NV_BATHEAT,
        &l_dev->count, sizeof(l_dev->count));
    hwlog_info("read nv count=%d\n", l_dev->count);
}

// 写入加热次数
static void bat_heating_write_count_work(struct work_struct *work)
{
    struct bat_heating_dev *l_dev = bat_heating_get_dev();
    
    (void)power_nv_write(POWER_NV_BATHEAT,
        &l_dev->count, sizeof(l_dev->count));
    hwlog_info("write nv count=%d\n", l_dev->count);
}
```

**用途：** 统计电池加热使用次数，用于电池健康评估

### 7.2 DMD 上报

```c
static void bat_heating_report_dmd_work(struct work_struct *work)
{
    struct bat_heating_dev *l_dev = bat_heating_get_dev();
    char buf[POWER_DSM_BUF_SIZE_0128] = { 0 };

    // 限制上报次数（最多 5 次）
    if (l_dev->dmd_count++ >= BAT_HEATING_DMD_REPORT_COUNTS) {
        hwlog_info("dmd report over %d time\n", l_dev->dmd_count);
        return;
    }

    // 构造 DMD 信息
    snprintf(buf, POWER_DSM_BUF_SIZE_0128 - 1,
        "count=%d chg_type=%d brand=%s volt=%d soc=%d t_bat=%d t_usb=%d\n",
        l_dev->count,                          // 加热次数
        charge_get_charger_type(),             // 充电器类型
        power_supply_app_get_bat_brand(),      // 电池品牌
        power_supply_app_get_bat_voltage_now(), // 电池电压
        power_supply_app_get_bat_capacity(),   // SOC
        l_dev->bat_temp,                       // 电池温度
        l_dev->usb_temp);                      // USB 温度
    
    // 上报 DMD
    power_dsm_report_dmd(POWER_DSM_BATTERY, 
        POWER_DSM_BATTERY_HEATING, buf);
}
```

**触发时机：** `trigger` 被设置为 1 时，延迟 3 秒上报

**上报示例：**
```
count=15 chg_type=3 brand=ATL volt=3850 soc=45 t_bat=-5 t_usb=-3
```

## 8. 典型应用场景

### 8.1 低温充电场景

**环境：** 室外温度 -10℃，电池温度 -8℃

```bash
# 1. 用户插入充电器
# 2. 系统接收 POWER_NE_CHARGING_START 事件
# 3. 延迟 15s 启动监控工作

# 4. 监控工作检查条件
#    ✓ 充电器类型: FCP (支持)
#    ✓ USB 状态: 已连接
#    ✓ SOC: 45% (< 99%)
#    ✓ 电流: -150mA (> -400mA)
#    ✓ 温度: bat=-8℃, usb=-7℃ (差值 1℃ < 15℃)
#    ✓ 温度范围: -8℃ ∈ [-10, 40]

# 5. bms_heating 守护进程设置 trigger
echo "bms_heating 1" > /sys/class/hw_power/bat_heating/trigger

# 6. 系统开始加热
#    • 发送 HEATING_START= uevent
#    • 根据温度设置充电电流: 1000mA (-10℃ ~ 0℃)

# 7. 温度逐渐上升
#    -8℃ → -5℃ → 0℃ → 5℃ → 10℃

# 8. 当温度达到 10℃ 时
#    • 切换到直充模式
#    • 增大充电电流: 2500mA

# 9. 温度继续上升至 40℃ 时停止加热
```

### 8.2 亮屏提示场景

**环境：** 正在加热，用户亮屏使用手机

```bash
# 1. 正在低温加热
heat_up_flag = true

# 2. 用户按下电源键，屏幕点亮
# 3. 系统接收 POWER_NE_PANEL_UNBLANK 事件
screen_state = BAT_HEATING_SCREEN_ON

# 4. 监控工作检测到亮屏
#    • 发送 HEATING_STOP= uevent (停止加热)
#    • 发送 UI 消息：power_ui_event_notify(POWER_UI_NE_HEATING_STATUS, 1)

# 5. SystemUI 显示提示
"正在低温加热，请息屏充电以获得最佳效果"

# 6. 用户息屏后
#    • 接收 POWER_NE_PANEL_BLANK 事件
#    • 发送 HEATING_START= uevent (恢复加热)
#    • 移除 UI 提示
```

### 8.3 直充路径切换场景

**环境：** 正在使用 BUCK 模式加热，系统切换到 SC 直充

```bash
# 1. BUCK 模式加热中
bat_temp = 8℃
charge_mode = BUCK
heating = true

# 2. 温度上升到 10℃，满足直充条件
# 3. 直充模块准备切换路径

# 4. 接收 POWER_NE_DC_SWITCH_PATH 事件
#    • 暂停加热: HEATING_STOP=
#    • 设置 dc_stop_flag = true

# 5. 直充切换中（约 2-3 秒）
#    • 断开 BUCK 通道
#    • 连接 SC 通道
#    • 协商电压

# 6. 接收 POWER_NE_DC_CHECK_SUCC 事件
#    • 恢复加热: HEATING_START=
#    • 设置 dc_stop_flag = false
#    • 使用 SC 模式继续加热
```

## 9. DTS 配置

### 9.1 配置示例

```dts
bat_heating {
    compatible = "huawei,bat_heating";
    status = "ok";
    
    /* 低温阈值 */
    low_temp_min_thld = "-10";      /* 最低温度 -10℃ */
    low_temp_max_thld = "5";        /* 最高温度 5℃ */
    low_temp_hysteresis = "35";     /* 滞后 35℃ (停止温度 = 5 + 35 = 40℃) */
    low_temp_min_ibat = "-400";     /* 最小电流 -400mA */
    
    /* BUCK 输入限流 */
    buck_iin_limit = "1300";        /* 1300mA */
    
    /* 温度-电流映射表 */
    temp_para = "-10", "0",  "1000",   /* -10℃ ~ 0℃: 1000mA */
                "0",   "5",  "1500",   /*   0℃ ~ 5℃: 1500mA */
                "5",   "10", "2000",   /*   5℃ ~ 10℃: 2000mA */
                "10",  "15", "2500",   /*  10℃ ~ 15℃: 2500mA */
                "15",  "20", "3000",   /*  15℃ ~ 20℃: 3000mA */
                "20",  "25", "3500",   /*  20℃ ~ 25℃: 3500mA */
                "25",  "30", "4000",   /*  25℃ ~ 30℃: 4000mA */
                "30",  "40", "4500";   /*  30℃ ~ 40℃: 4500mA */
};
```

### 9.2 参数调优建议

| 参数 | 默认值 | 调优方向 | 影响 |
|-----|-------|---------|------|
| low_temp_min_thld | -10℃ | 根据电池规格调整 | 过低可能损害电池 |
| low_temp_max_thld | 5℃ | 根据气候调整 | 过高影响用户体验 |
| low_temp_hysteresis | 35℃ | 防抖时间 | 过小会频繁启停 |
| low_temp_min_ibat | -400mA | 过载保护阈值 | 过小容易误触发 |
| temp_para | 8 档 | 增减档位 | 控制精度 vs 复杂度 |

## 10. 调试方法

### 10.1 日志分析

**使能动态日志：**

```bash
echo 'file bat_heating.c +p' > /sys/kernel/debug/dynamic_debug/control
```

**关键日志：**

```bash
# 充电启动
[bat_heating] receive battery heating start event

# 条件检查
[bat_heating] check: charger_type=3 is invalid
[bat_heating] check: screen on
[bat_heating] check: soc=99 is invalid
[bat_heating] check: count=15 current=-500 is overload
[bat_heating] check: usb_temp=-5 bat_temp=18

# 加热控制
[bat_heating] trigger
[bat_heating] start heat up

# 停止加热
[bat_heating] stop heat up
[bat_heating] monitor work exit
```

### 10.2 Sysfs 调试

```bash
# 查看当前状态
cat /sys/class/hw_power/bat_heating/heat_up    # 0/1
cat /sys/class/hw_power/bat_heating/count      # 加热次数
cat /sys/class/hw_power/bat_heating/trigger    # 触发状态

# 手动触发加热（工程模式）
echo "shell 1" > /sys/class/hw_power/bat_heating/trigger

# 查看调试参数
cat /sys/kernel/debug/power/bat_heating/para
```

### 10.3 故障诊断流程

```
问题：低温加热不工作
  ├─ 1. 检查功能是否使能
  │    └─ 确认非关机充电模式、非工厂模式
  │
  ├─ 2. 检查充电器类型
  │    └─ cat /sys/class/power_supply/*/type
  │       （应为 DCP/FCP/SCP/PD）
  │
  ├─ 3. 检查温度范围
  │    └─ cat /sys/class/power_supply/battery/temp
  │       （应在 -10℃ ~ 40℃）
  │
  ├─ 4. 检查 SOC
  │    └─ cat /sys/class/power_supply/battery/capacity
  │       （应 < 99%）
  │
  ├─ 5. 检查电流
  │    └─ cat /sys/class/power_supply/battery/current_now
  │       （应 > -400mA）
  │
  ├─ 6. 检查屏幕状态
  │    └─ 确认息屏状态
  │
  └─ 7. 查看 uevent 日志
       └─ dmesg | grep "HEATING_"
```

## 11. 设计亮点

### 11.1 温度滞后机制

**问题：** 温度在阈值附近波动导致频繁启停

**解决方案：** 引入 35℃ 滞后

```c
// 启动条件：-10℃ ≤ temp ≤ 5℃
// 停止条件：temp < -10℃ 或 temp > 40℃ (5 + 35)
l_dev->hysteresis = l_dev->low_temp_hysteresis;  // 35℃
```

**效果：** 防止温度在 5℃ 附近抖动

### 11.2 过载保护

**问题：** 瞬时电流波动导致误判

**解决方案：** 连续 20 次（100 秒）过载才触发

```c
if (cur < l_dev->low_temp_min_ibat) {
    if (l_dev->overload_count++ >= BAT_HEATING_OVERLOAD_THLD)  // 20
        return true;  // 真正过载
}
```

### 11.3 屏幕状态联动

**问题：** 亮屏使用时大电流充电影响性能

**解决方案：** 亮屏时停止加热，显示 UI 提示

```c
if (bat_heating_check_screen_state(l_dev)) {
    bat_heating_send_uevent(l_dev, BAT_HEATING_POPUP_UI_MSG);
    bat_heating_send_uevent(l_dev, BAT_HEATING_STOP_HEAT_UP);
}
```

### 11.4 直充切换保护

**问题：** 直充路径切换时电流控制冲突

**解决方案：** 切换期间暂停加热

```c
case POWER_NE_DC_SWITCH_PATH:
    bat_heating_send_uevent(l_dev, BAT_HEATING_STOP_HEAT_UP);
    l_dev->dc_stop_flag = true;
    break;
```

### 11.5 分模式电流控制

**问题：** 不同温度下充电模式不同

**解决方案：** 10℃ 为分界点

```c
if (l_dev->bat_temp >= BAT_HEATING_DC_TEMP_THLD) {  // 10℃
    // 直充模式：限制输入电流
    power_if_kernel_sysfs_set(POWER_IF_OP_TYPE_LVC, ...);
} else {
    // BUCK 模式：限制充电电流
    power_if_kernel_sysfs_set(POWER_IF_OP_TYPE_DCP, ...);
}
```

## 12. 总结

bat_heating 模块是华为充电管理系统中的**低温电池加热控制组件**，通过以下设计实现了智能、安全的加热管理：

**核心特性：**
1. ✅ **多重保护**：充电器类型、SOC、电流、温度、屏幕状态等 6 重检查
2. ✅ **智能控制**：温度分段电流映射 + 滞后防抖
3. ✅ **分模式优化**：< 10℃ BUCK 模式，≥ 10℃ 直充模式
4. ✅ **用户友好**：亮屏提示，避免性能影响
5. ✅ **数据采集**：NV 存储加热次数，DMD 上报异常

**应用价值：**
- ❄️ **低温充电**：-10℃ ~ 5℃ 环境下保证充电性能
- 🔥 **快速升温**：通过大电流充电快速提升电池温度
- 🛡️ **电池保护**：避免低温充电损害电池寿命
- 📱 **用户体验**：息屏自动加热，亮屏智能提示

**典型应用：**
- 🏔️ 高寒地区使用
- ⛷️ 冬季户外运动
- 🚗 车载低温环境
- 📸 极端气候拍摄

该模块充分体现了**温度自适应控制**和**多场景联动保护**的设计思想，是低温环境下充电管理的核心组件。