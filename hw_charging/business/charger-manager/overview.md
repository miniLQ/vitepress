---
outline: deep
---
# 华为充电管理之charger_manager

## 一、模块概述

`charge_manager` 是华为充电管理子系统中的**充电事件管理与调度核心模块**，负责统一管理**有线充电、无线充电、OTG 反向供电**等多种充电模式，协调 **BC1.2、PD、SCP/FCP、直充（Direct Charge）、Buck 充电**等多种充电协议，对上层提供统一的充电事件接口。

**核心功能：**
- **充电事件管理：** START_SINK/STOP_SINK/START_SOURCE/STOP_SOURCE 等事件的状态机管理
- **充电器类型识别：** 协调 BC1.2、PD、无线充电等多种识别结果
- **充电模式切换：** PD → SCP 降级、直充 → Buck 充电切换
- **充电监控调度：** 周期性监控充电状态，调度直充、快充检测
- **Power Supply 接口：** 提供 charge_manager 和 usb power supply 设备
- **事件队列机制：** 异步处理充电插拔事件，防止竞态条件
- **唤醒锁管理：** 充电期间持有唤醒锁，防止系统休眠

**架构图：**

```
┌─────────────────────────────────────────────────┐
│            Charge Manager Core                  │
│  ┌──────────────────────────────────────────┐  │
│  │       Event State Machine                 │  │
│  │  START_SINK → STOP_SINK                  │  │
│  │  START_SOURCE → STOP_SOURCE              │  │
│  │  START_SINK_WIRELESS → STOP_SINK_WIRELESS│ │
│  └──────────────────────────────────────────┘  │
└──────────────┬──────────────────────────────────┘
               │
      ┌────────┴────────┐
      │                 │
┌─────▼─────┐     ┌────▼──────┐
│ BC1.2     │     │ PD/TypeC  │
│ Detection │     │ Negotiation│
└─────┬─────┘     └────┬──────┘
      │                │
      └────────┬───────┘
               │
    ┌──────────▼──────────┐
    │ Charger Type Handler│
    └──────────┬──────────┘
               │
      ┌────────┴────────┐
      │                 │
┌─────▼─────┐     ┌────▼──────┐
│ Direct    │     │   Buck    │
│ Charge    │     │  Charge   │
│ Check     │     │  Entry    │
└───────────┘     └───────────┘
```

---

## 二、主要数据结构

### 2.1 设备结构体 `charge_manager_info`

```c
struct charge_manager_info {
    struct device *dev;                      // 设备指针
    struct power_supply *charge_psy;         // charge_manager power supply
    struct power_supply *usb_psy;            // usb power supply（可选）
    
    /* 工作队列 */
    struct delayed_work charge_work;         // 充电监控工作队列（周期性）
    struct work_struct event_work;           // 事件处理工作队列（异步）
    
    /* 事件管理 */
    struct mutex event_type_lock;            // 充电器类型变更锁
    spinlock_t event_spin_lock;              // 事件队列自旋锁
    enum charger_event_type event;           // 当前充电事件状态
    struct charger_event_queue event_queue;  // 事件队列
    
    /* 唤醒锁 */
    struct wakeup_source *charge_lock;       // 充电唤醒锁
    
    /* 配置参数 */
    int support_usb_psy;                     // 是否支持 usb power supply
    int charger_pd_support;                  // 是否支持 PD 协议
    int force_disable_dc_path;               // 强制禁用直充路径标志
    int enable_hv_charging;                  // 使能高压充电
    
    /* 运行时状态 */
    int try_pd_to_scp_counter;               // PD→SCP 尝试计数器
    int usb_online;                          // USB 在线状态
    int bc12_chg_type;                       // BC1.2 充电器类型
    
#ifdef CONFIG_TCPC_CLASS
    struct notifier_block tcpc_nb;           // PD 通知块
    struct pd_dpm_vbus_state *vbus_state;    // PD VBUS 状态
#endif
};
```

---

## 2.2 充电事件状态机

### 2.2.1 事件类型 `charger_event_type`

| 事件 | 值 | 说明 |
|------|---|------|
| `START_SINK` | - | 开始有线充电（接收电源） |
| `STOP_SINK` | - | 停止有线充电 |
| `START_SOURCE` | - | 开始 OTG 供电（输出电源） |
| `STOP_SOURCE` | - | 停止 OTG 供电 |
| `START_SINK_WIRELESS` | - | 开始无线充电 |
| `STOP_SINK_WIRELESS` | - | 停止无线充电 |
| `CHARGER_MAX_EVENT` | - | 无效事件/初始状态 |

### 2.2.2 状态转换检查 `charger_event_check()`

**允许的状态转换矩阵：**

| 当前状态 | 允许转换到的状态 |
|---------|-----------------|
| `STOP_SINK` | START_SINK, START_SOURCE, START_SINK_WIRELESS |
| `START_SINK` | STOP_SINK |
| `STOP_SOURCE` | START_SINK, START_SOURCE, START_SINK_WIRELESS |
| `START_SOURCE` | STOP_SOURCE |
| `STOP_SINK_WIRELESS` | START_SINK, START_SOURCE, START_SINK_WIRELESS |
| `START_SINK_WIRELESS` | STOP_SINK_WIRELESS |

**设计理念：** 防止非法状态转换（如充电中直接切换到 OTG，必须先停止充电）。

**代码实现：**

```c
static bool charger_event_check(struct charge_manager_info *di,
    enum charger_event_type new_event)
{
    if (di->event == CHARGER_MAX_EVENT)
        return true;  // 初始状态，允许任何转换

    switch (new_event) {
    case START_SINK:
        if ((di->event == STOP_SINK) || (di->event == STOP_SOURCE) ||
            (di->event == START_SINK_WIRELESS) || (di->event == STOP_SINK_WIRELESS))
            return true;
        break;
    // ... 其他状态转换逻辑
    }
    return false;
}
```

---

## 三、核心工作流程

### 3.1 充电监控工作队列 `charge_monitor_work()`

**执行周期：**

| 场景 | 监控间隔 |
|------|---------|
| 正常充电 | 10 秒（MONITOR_CHARGING_DELAY_TIME） |
| PD 初始化等待 | 2 秒（MONITOR_CHARGING_WAITPD_TIMEOUT） |
| PD→SCP 尝试中 | 1 秒（MONITOR_CHARGING_QUICKEN_DELAY_TIME） |
| 快速充电检测 | 1 秒（quicken_work_flag 触发） |

**工作流程：**

```c
charge_monitor_work():
    1. 检查 PD 初始化标志
       └─ 开机 6 秒后清除 PD 初始化标志
    
    2. PD→SCP 降级尝试
       └─ charge_try_pd2scp()
          ├─ 检测是否有 CTC 线缆（支持 SCP）
          ├─ 执行直充预检查
          ├─ 检测 emark 电缆（PD 3.0）
          └─ 禁用 PD，切换到 BC1.2 DCP + SCP
    
    3. 直充检测
       └─ charge_direct_charge_check()
          ├─ 仅在充电器类型为 STANDARD 时触发
          ├─ 检查 PD 初始化状态
          └─ 调用 direct_charge_check()
    
    4. Buck 充电启动
       └─ buck_charge_entry()
          └─ 未进入直充时，启动常规 Buck 充电
    
    5. 调度下次监控
       └─ 根据当前状态选择监控间隔
```

### 3.2 充电器类型处理 `charger_type_handler()`

**支持的充电器类型：**

| 类型 | 说明 | USB PSY Type | 触发动作 |
|------|------|-------------|---------|
| `CHARGER_TYPE_USB` | SDP（标准 USB） | POWER_SUPPLY_TYPE_USB | 重新调度监控 |
| `CHARGER_TYPE_BC_USB` | CDP（充电下游端口） | POWER_SUPPLY_TYPE_USB_CDP | 工厂模式识别为 SDP |
| `CHARGER_TYPE_STANDARD` | DCP（专用充电端口） | POWER_SUPPLY_TYPE_USB_DCP | 可能触发直充检测 |
| `CHARGER_TYPE_NON_STANDARD` | 非标准充电器 | POWER_SUPPLY_TYPE_USB_DCP | 重新调度监控 |
| `PD_DPM_VBUS_TYPE_PD` | PD 充电器 | POWER_SUPPLY_TYPE_USB_PD | 触发 PD→SCP 尝试 |
| `CHARGER_TYPE_WIRELESS` | 无线充电 | POWER_SUPPLY_TYPE_WIRELESS | 重新调度监控 |

**类型识别优先级：**

```
PD → FCP/SCP → DCP → CDP → SDP → 非标准
```

**示例流程（DCP 充电器插入）：**

```
1. BC1.2 检测完成 → CHARGER_TYPE_STANDARD
   ↓
2. charger_type_handler(CHARGER_TYPE_STANDARD)
   ├─ charge_set_charger_type(CHARGER_TYPE_STANDARD)
   ├─ charge_update_usb_psy_type(POWER_SUPPLY_TYPE_USB_DCP)
   └─ mod_delayed_work(&charge_work, 0)
   ↓
3. charge_monitor_work() 执行
   ├─ charge_direct_charge_check()  // 尝试直充
   └─ buck_charge_entry()            // 或启动 Buck 充电
```

### 3.3 PD→SCP 降级机制 `charge_try_pd2scp()`

**触发条件：**

1. 检测到 CTC 线缆（支持 SCP 协议）
2. `try_pd_to_scp_counter > 0`（最多尝试 5 次）
3. 监控工作未停止

**降级流程：**

```c
charge_try_pd2scp():
    1. 清除 PD 初始化标志
    
    2. 执行直充预检查
       └─ direct_charge_pre_check()
    
    3. 若预检查失败：
       ├─ 检测 emark 电缆（等待 200ms）
       ├─ 禁用 USBPD 协议
       │   ├─ charge_set_vbus_vset(ADAPTER_5V)
       │   ├─ pd_dpm_disable_pd(true)
       │   └─ adapter_set_usbpd_enable(SCP, true)
       ├─ 等待 800ms（BC1.2 重新检测）
       └─ 切换充电器类型为 STANDARD
    
    4. 若预检查成功：
       └─ 减少计数器，继续尝试
    
    5. 计数器归零后停止尝试
```

**设计目的：** 对于同时支持 PD 和 SCP 的充电器，优先使用 SCP 协议（华为私有快充），提高充电功率。

### 3.4 充电事件处理 `charger_handle_event()`

#### 3.4.1 START_SINK（开始有线充电）

```c
1. 发送 USB 连接事件
   └─ power_event_bnc_notify(POWER_BNT_CONNECT, POWER_NE_USB_CONNECT)
   
2. 更新充电图标
   └─ power_icon_notify(ICON_TYPE_NORMAL)
   
3. 初始充电器类型识别
   └─ charger_type_handler(CHARGER_TYPE_SDP)
   
4. 启动充电流程
   └─ charge_start_charging()
      ├─ 获取唤醒锁
      ├─ buck_charge_init_chip()  // 初始化充电芯片
      ├─ 启动监控工作队列
      └─ 发送 POWER_NE_CHARGING_START 事件
```

#### 3.4.2 STOP_SINK（停止有线充电）

```c
1. 发送 USB 断开事件
   └─ power_event_bnc_notify(POWER_BNT_CONNECT, POWER_NE_USB_DISCONNECT)
   
2. 发送预停止充电事件
   └─ power_event_bnc_notify(POWER_BNT_CHG, POWER_NE_CHG_PRE_STOP_CHARGING)
   
3. 无线充电有线断开处理
   └─ wireless_charge_wired_vbus_disconnect_handler()
   
4. 更新充电器状态
   ├─ charge_set_charger_type(CHARGER_REMOVED)
   ├─ charge_update_usb_psy_type(POWER_SUPPLY_TYPE_USB)
   └─ power_icon_notify(ICON_TYPE_INVALID)
   
5. 停止充电流程
   └─ charge_stop_charging()
      ├─ 复位适配器参数（FCP/SCP）
      ├─ 强制退出直充（如需要）
      ├─ buck_charge_stop_charging()
      ├─ 取消监控工作队列
      ├─ direct_charge_exit()
      └─ 释放唤醒锁
```

#### 3.4.3 START_SOURCE（开始 OTG 供电）

```c
1. 释放唤醒锁
2. 使能 OTG 模式
   └─ charge_otg_mode_enable(CHARGE_OTG_ENABLE, VBUS_CH_USER_WIRED_OTG)
```

#### 3.4.4 START_SINK_WIRELESS（开始无线充电）

```c
1. 发送无线连接事件
   └─ power_event_bnc_notify(POWER_BNT_CONNECT, POWER_NE_WIRELESS_CONNECT)
   
2. 更新无线充电图标
   └─ power_icon_notify(ICON_TYPE_WIRELESS_NORMAL)
   
3. 更新充电器类型
   ├─ charge_set_charger_type(CHARGER_TYPE_WIRELESS)
   └─ charge_update_usb_psy_type(POWER_SUPPLY_TYPE_WIRELESS)
   
4. 启动充电流程
   └─ charge_start_charging()
```

### 3.5 事件队列机制

**队列特性：**
- **异步处理：** 插拔事件加入队列后立即返回，避免阻塞调用者
- **顺序保证：** FIFO 队列，保证事件按时间顺序处理
- **覆盖机制：** STOP 事件设置覆盖标志，清除队列中的旧事件
- **自旋锁保护：** 防止多线程并发访问队列

**处理流程：**

```c
charger_source_sink_event(event):
    1. 检查事件合法性
       └─ charger_event_check() // 状态转换验证
    
    2. 更新充电在线状态
       └─ charge_set_charger_online()
    
    3. 事件入队
       └─ charger_event_enqueue(&event_queue, event)
    
    4. 调度事件处理工作队列
       └─ queue_work(&event_work)
    
    5. STOP 事件特殊处理
       └─ charger_event_queue_set_overlay()  // 清除旧事件

charger_event_work():
    1. 循环处理队列中的所有事件
       while (!charger_event_queue_isempty()) {
           event = charger_event_dequeue()
           charger_handle_event(event)
       }
    
    2. 清除覆盖标志
       └─ charger_event_queue_clear_overlay()
```

---

## 四、Power Supply 接口

### 4.1 charge_manager Power Supply

**属性列表：**

| 属性 | 类型 | 说明 |
|------|------|------|
| `POWER_SUPPLY_PROP_CHG_PLUGIN` | 可写 | 充电插拔事件（接收事件通知） |
| `POWER_SUPPLY_PROP_CHG_TYPE` | 读写 | BC1.2 充电器类型 |

**set_property 实现：**

```c
POWER_SUPPLY_PROP_CHG_PLUGIN:
    接收充电事件（START_SINK/STOP_SINK 等）
    ↓
    charger_source_sink_event(event)

POWER_SUPPLY_PROP_CHG_TYPE:
    接收 BC1.2 检测结果
    ↓
    charger_type_handler(bc12_chg_type)
```

**使用示例：**

```bash
# 模拟充电器插入
echo 0 > /sys/class/power_supply/charge_manager/chg_plugin  # START_SINK

# 模拟充电器拔出
echo 1 > /sys/class/power_supply/charge_manager/chg_plugin  # STOP_SINK

# 查询 BC1.2 类型
cat /sys/class/power_supply/charge_manager/chg_type
```

### 4.2 usb Power Supply（可选）

**DTS 配置：**

```
charge_manager {
    compatible = "huawei,charge_manager";
    support_usb_psy = <1>;  // 使能 usb power supply
};
```

**属性列表：**

| 属性 | 类型 | 说明 |
|------|------|------|
| `POWER_SUPPLY_PROP_ONLINE` | 读写 | USB 在线状态 |
| `POWER_SUPPLY_PROP_VOLTAGE_NOW` | 只读 | VBUS 电压（uV） |

**get_property 实现：**

```c
POWER_SUPPLY_PROP_ONLINE:
    返回 di->usb_online

POWER_SUPPLY_PROP_VOLTAGE_NOW:
    调用 charge_get_vusb() 获取 VBUS 电压
    转换为 uV 单位（× 1000）
```

**动态类型更新：**

```c
static void charge_update_usb_psy_type(unsigned int type)
{
    if (g_usb_psy_desc.type == type)
        return;  // 类型未变化，跳过

    g_usb_psy_desc.type = type;  // 更新类型
    power_supply_changed(g_di->usb_psy);  // 通知上层
}
```

**类型映射表：**

| 充电器类型 | USB PSY Type |
|-----------|-------------|
| SDP | POWER_SUPPLY_TYPE_USB |
| CDP | POWER_SUPPLY_TYPE_USB_CDP |
| DCP | POWER_SUPPLY_TYPE_USB_DCP |
| PD | POWER_SUPPLY_TYPE_USB_PD |
| 无线 | POWER_SUPPLY_TYPE_WIRELESS |

---

## 五、PD 集成机制

### 5.1 PD 通知回调 `pd_dpm_notifier_call()`

**监听事件：**

| 事件 | 处理 |
|------|------|
| `CHARGER_TYPE_DCP` | PD 充电中检测到 DCP，触发 PD→SCP 尝试 |
| `PD_DPM_VBUS_TYPE_PD` | PD 协商完成，更新充电器类型为 PD |

**PD→SCP 触发逻辑：**

```c
if ((di->event == START_SINK) && 
    (event == CHARGER_TYPE_DCP) &&
    (charge_get_charger_type() == CHARGER_TYPE_PD)) {
    // PD 充电中检测到 DCP（PD 协商失败或降级）
    di->try_pd_to_scp_counter = PD_TO_SCP_MAX_COUNT;
    mod_delayed_work(&di->charge_work, 0);  // 立即执行监控
}
```

**VBUS 状态传递：**

```c
if (event == PD_DPM_VBUS_TYPE_PD) {
    vbus_state = (struct pd_dpm_vbus_state *) data;
    buck_charge_set_pd_vbus_state(vbus_state);  // 传递给 Buck 充电模块
    
    if (vbus_state->ext_power)
        charge_update_usb_psy_type(POWER_SUPPLY_TYPE_USB_PD);
    else
        charge_update_usb_psy_type(POWER_SUPPLY_TYPE_USB);
}
```

---

## 六、电源管理

### 6.1 Suspend/Resume

#### 6.1.1 Suspend 流程

```c
charge_manager_suspend():
    1. 取消监控工作队列
       └─ cancel_delayed_work(&charge_work)
    
    2. 充电完成时禁用看门狗
       └─ if (charge_done)
              charge_disable_watchdog()
```

#### 6.1.2 Resume 流程

```c
charge_manager_resume():
    1. 检查充电完成状态
    
    2. 若充电完成：
       ├─ 获取唤醒锁
       └─ 立即调度监控工作队列
          └─ mod_delayed_work(&charge_work, 0)
```

### 6.2 Shutdown

```c
charge_manager_shutdown():
    1. 取消监控工作队列
       └─ cancel_delayed_work(&charge_work)
```

---

## 七、初始化流程

### 7.1 Probe 流程 `charge_manager_probe()`

```
1. 分配设备结构体
   ↓
2. 解析 DTS 配置
   ├─ support_usb_psy
   └─ pd_support
   ↓
3. 初始化 Power Supply
   ├─ 注册 charge_manager power supply
   └─ 注册 usb power supply（可选）
   ↓
4. 初始化同步机制
   ├─ 创建唤醒锁
   ├─ 初始化事件队列
   ├─ 初始化自旋锁
   └─ 初始化互斥锁
   ↓
5. 注册工作队列
   ├─ INIT_WORK(&event_work)
   └─ INIT_DELAYED_WORK(&charge_work)
   ↓
6. 注册 PD 通知回调（如支持）
   └─ register_pd_dpm_notifier()
   ↓
7. 初始化充电器状态
   ├─ charge_set_charger_type(CHARGER_REMOVED)
   └─ charge_set_pd_init_flag(true)
   ↓
8. 检测初始充电状态
   ├─ 检测无线充电器
   ├─ 获取 PD 状态
   └─ 触发初始充电事件
   ↓
9. 记录开机时间
   └─ g_boot_time = power_get_monotonic_boottime()
```

### 7.2 DTS 配置

```
charge_manager {
    compatible = "huawei,charge_manager";
    
    /* 是否支持 usb power supply */
    support_usb_psy = <1>;
    
    /* 是否支持 PD 协议 */
    pd_support = <1>;
};
```

---

## 八、调试技巧

### 8.1 查看当前充电事件

```bash
dmesg | grep "charge_manager" | grep "case ="
```

输出示例：
```
charge_manager: case = START_SINK
charge_manager: case = CHARGER_TYPE_PD
```

### 8.2 查看充电器类型变化

```bash
dmesg | grep "update usb_psy_type"
```

输出示例：
```
charge_manager: update usb_psy_type = 4  // POWER_SUPPLY_TYPE_USB_DCP
charge_manager: update usb_psy_type = 6  // POWER_SUPPLY_TYPE_USB_PD
```

### 8.3 监控 PD→SCP 降级过程

```bash
dmesg | grep "try_pd_to_scp"
```

输出示例：
```
charge_manager: try_pd_to_scp try_pd_to_scp
charge_manager: wait out full time curr_capacity=95
charge_manager: CHARGER_TYPE_STANDARD
```

### 8.4 查看监控工作队列执行

在 charge_manager.c 中添加日志：

```c
hwlog_info("monitor_work: type=%d, dc_stage=%d, pd_init=%d, counter=%d\n",
    charge_type, direct_charge_in_charging_stage(),
    charge_get_pd_init_flag(), di->try_pd_to_scp_counter);
```

### 8.5 模拟充电事件

```bash
# 开始充电
echo 0 > /sys/class/power_supply/charge_manager/chg_plugin

# 停止充电
echo 1 > /sys/class/power_supply/charge_manager/chg_plugin
```

### 8.6 查看事件队列状态

在 charge_manager.c 中添加日志：

```c
hwlog_info("event_work: queue_size=%d, event=%s\n",
    charger_event_queue_size(&di->event_queue),
    charger_event_type_string(event));
```

---

## 九、关键宏定义

```c
#define MONITOR_CHARGING_DELAY_TIME         10000  // 正常监控间隔 10s
#define MONITOR_CHARGING_QUICKEN_DELAY_TIME 1000   // 快速监控间隔 1s
#define MONITOR_CHARGING_WAITPD_TIMEOUT     2000   // PD 等待超时 2s
#define CHG_WAIT_PD_TIME                    6      // PD 初始化等待 6s
#define PD_TO_SCP_MAX_COUNT                 5      // PD→SCP 最大尝试次数
```

## 十、典型应用场景

### 10.1 场景 1：标准充电器插入

**流程：**

```
1. 硬件检测到 VBUS
   ↓
2. 调用 charger_source_sink_event(START_SINK)
   ↓
3. 事件入队并触发 charger_event_work()
   ↓
4. charger_handle_event(START_SINK)
   ├─ power_icon_notify(ICON_TYPE_NORMAL)
   ├─ charger_type_handler(CHARGER_TYPE_SDP)  // 初始类型
   └─ charge_start_charging()
      ├─ buck_charge_init_chip()
      └─ schedule charge_work
   ↓
5. BC1.2 检测完成 → DCP
   ↓
6. charger_type_handler(CHARGER_TYPE_STANDARD)
   ├─ charge_update_usb_psy_type(POWER_SUPPLY_TYPE_USB_DCP)
   └─ mod_delayed_work(&charge_work, 0)
   ↓
7. charge_monitor_work() 执行
   ├─ charge_direct_charge_check()  // 检测是否支持直充
   └─ buck_charge_entry()            // 启动 Buck 充电
```

### 10.2 场景 2：PD 充电器插入（支持 SCP）

**流程：**

```
1. START_SINK 事件
   ↓
2. PD 协商完成
   ↓
3. pd_dpm_notifier_call(PD_DPM_VBUS_TYPE_PD)
   ├─ charge_set_charger_type(CHARGER_TYPE_PD)
   └─ try_pd_to_scp_counter = 5
   ↓
4. charge_monitor_work() 执行
   ↓
5. charge_try_pd2scp()
   ├─ 检测 CTC 线缆 ✓
   ├─ direct_charge_pre_check() → 支持直充
   ├─ pd_dpm_detect_emark_cable()
   ├─ charger_disable_usbpd(true)  // 禁用 PD
   ├─ msleep(800)  // 等待 BC1.2 重新检测
   └─ charger_switch_type_to_standard()
      ├─ charge_set_charger_type(CHARGER_TYPE_STANDARD)
      └─ charge_update_usb_psy_type(POWER_SUPPLY_TYPE_USB_DCP)
   ↓
6. charge_monitor_work() 再次执行
   ↓
7. direct_charge_check()  // 尝试 SCP 直充
```

### 10.3 场景 3：无线充电器放置

**流程：**

```
1. 无线充电检测到接收器
   ↓
2. charger_source_sink_event(START_SINK_WIRELESS)
   ↓
3. charger_handle_event(START_SINK_WIRELESS)
   ├─ power_icon_notify(ICON_TYPE_WIRELESS_NORMAL)
   ├─ charge_set_charger_type(CHARGER_TYPE_WIRELESS)
   ├─ charge_update_usb_psy_type(POWER_SUPPLY_TYPE_WIRELESS)
   └─ charge_start_charging()
   ↓
4. charge_monitor_work() 执行
   └─ buck_charge_entry()  // 无线充电使用 Buck 模式
```

### 10.4 场景 4：OTG 反向供电

**流程：**

```
1. 用户使能 OTG
   ↓
2. charger_source_sink_event(START_SOURCE)
   ↓
3. charger_handle_event(START_SOURCE)
   └─ charge_otg_mode_enable(CHARGE_OTG_ENABLE, VBUS_CH_USER_WIRED_OTG)
   ↓
4. VBUS 输出使能
```

---

## 十一、错误处理

### 11.1 常见错误场景

#### 11.1.1 非法状态转换

**日志：**
```
charge_manager: last event: [START_SINK], event [START_SOURCE] was rejected
```

**原因：** 充电中直接切换到 OTG，未先停止充电。

**解决方案：**
```c
// 正确流程
charger_source_sink_event(STOP_SINK);
msleep(100);  // 等待停止完成
charger_source_sink_event(START_SOURCE);
```

#### 11.1.2 PD 初始化超时

**日志：**
```
charge_manager: PD init timeout after 6s
```

**原因：** PD 协商耗时过长或失败。

**处理：** 6 秒后自动清除 `pd_init_flag`，继续充电流程。

#### 11.1.3 BC1.2 类型误识别

**日志：**
```
charge_manager: case = CHARGER_TYPE_STANDARD
charge_manager: case = CHARGER_TYPE_PD
```

**原因：** BC1.2 检测到 DCP，但随后 PD 协商成功，类型更新。

**处理：** 允许类型升级（DCP → PD），触发重新调度。

---

## 十二、外部接口

### 12.1 充电事件通知

```c
void charger_source_sink_event(enum charger_event_type event);
```

**调用者：** USB/TypeC 驱动、无线充电驱动。

**用途：** 通知充电管理器充电器插拔/OTG 切换事件。

### 12.2 emark 检测完成

```c
void emark_detect_complete(void);
```

**调用者：** PD 驱动。

**用途：** 通知 emark 电缆检测完成，唤醒等待队列。

### 12.3 释放唤醒锁

```c
void charge_manager_release_charge_lock(void);
```

**调用者：** 充电模块。

**用途：** 外部释放充电唤醒锁（如充电完成后）。

---

## 十三、总结

`charge_manager` 模块通过**事件驱动状态机**和**多充电模式协调**，实现了统一的充电管理框架。核心亮点包括：

1. **事件队列机制：** 异步处理充电插拔事件，防止竞态条件和阻塞
2. **状态转换保护：** 严格的状态机检查，防止非法充电模式切换
3. **多协议协调：** PD、SCP、FCP、无线充电统一管理，自动选择最优协议
4. **PD→SCP 降级：** 智能检测并切换到华为私有快充协议
5. **充电监控调度：** 自适应监控间隔，平衡响应速度和功耗
6. **Power Supply 抽象：** 标准化接口对接 Android Framework
7. **唤醒锁管理：** 充电期间保持系统唤醒，确保充电可靠性

该模块是华为充电系统的核心调度中枢，广泛应用于旗舰手机、折叠屏等设备，支持复杂的多模充电场景和快充协议。