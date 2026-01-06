---
outline: deep
---

# Power Event 事件通知机制模块

## 1. 模块定位与核心价值

### 1.1 系统角色

Power Event 是华为电源管理系统中的**中央事件总线**，提供了一个统一的、跨模块的事件发布-订阅机制。该模块解决了电源子系统内部各模块间的解耦通信问题。

**核心问题域：**
- 电源子系统包含 20+ 独立模块（充电、库仑计、无线充电、直充、OTG等）
- 模块间存在大量状态同步需求（如：直充启动需通知UI更新、温度异常需通知充电停止）
- 传统函数调用导致模块紧耦合，难以维护和扩展

**解决方案：**
```
发布者模块                    事件总线                     订阅者模块
──────────                    ────────                     ──────────
直充模块                                                   UI模块
  ├─ 检测到适配器  ─────→  POWER_NE_DC_CHECK_SUCC  ───→  更新充电图标
  └─ 充电启动      ─────→  POWER_NE_DC_LVC_CHARGING ───→  显示快充动画

充电管理                                                   电池健康监控
  ├─ 充电开始      ─────→  POWER_NE_CHARGING_START  ───→  记录充电次数
  └─ 充电停止      ─────→  POWER_NE_CHARGING_STOP   ───→  更新统计数据

库仑计                                                     关机管理
  └─ 电量过低      ─────→  POWER_NE_COUL_LOW_VOL    ───→  触发低电关机
```

### 1.2 架构设计

```
┌─────────────────────────────────────────────────────────┐
│  Power Event 模块 (cc_common_module/power_event)        │
│                                                          │
│  ┌──────────────────────────────────────────────────┐  │
│  │  Blocking Notifier Chains (BNC) - 可阻塞通知链   │  │
│  │  ├─ POWER_BNT_CONNECT   (USB/无线连接事件)       │  │
│  │  ├─ POWER_BNT_CHARGING  (充电状态事件)           │  │
│  │  ├─ POWER_BNT_DC        (直充事件)               │  │
│  │  ├─ POWER_BNT_WLC       (无线充电事件)           │  │
│  │  ├─ POWER_BNT_OTG       (OTG事件)                │  │
│  │  └─ ... 共 30+ 通知链类型                        │  │
│  └──────────────────────────────────────────────────┘  │
│                                                          │
│  ┌──────────────────────────────────────────────────┐  │
│  │  Atomic Notifier Chains (ANC) - 原子通知链       │  │
│  │  ├─ POWER_ANT_CHARGE_FAULT (充电器故障)          │  │
│  │  ├─ POWER_ANT_DC_FAULT     (直充故障)            │  │
│  │  └─ ... 共 7 个原子通知链                        │  │
│  └──────────────────────────────────────────────────┘  │
│                                                          │
│  ┌──────────────────────────────────────────────────┐  │
│  │  UEvent 上报 - 内核到用户空间事件传递             │  │
│  │  /sys/class/hw_power/power_event/                │  │
│  └──────────────────────────────────────────────────┘  │
└─────────────────────────────────────────────────────────┘
```

---

## 2. 双通知链机制详解

### 2.1 Blocking Notifier Chain (BNC) - 可阻塞通知链

**使用场景：** 允许回调函数执行耗时操作（如 I2C 通信、延迟等待）

**内核机制：**
```c
// 初始化通知链
static struct blocking_notifier_head g_power_event_bnh[POWER_BNT_END];

void power_event_bnc_init(void)
{
    for (i = 0; i < POWER_BNT_END; i++)
        BLOCKING_INIT_NOTIFIER_HEAD(&g_power_event_bnh[i]);
}
```

**注册订阅：**
```c
// 模块注册回调函数
struct notifier_block my_nb = {
    .notifier_call = my_event_handler,
};

power_event_bnc_register(POWER_BNT_DC, &my_nb);
```

**发布事件：**
```c
// 直充模块通知适配器检测成功
power_event_bnc_notify(POWER_BNT_DC, POWER_NE_DC_CHECK_SUCC, NULL);

// 带数据的事件通知
int adapter_mode = 0x16;  // LVC + SC
power_event_bnc_notify(POWER_BNT_DC, POWER_NE_DC_ADAPTER_MODE, &adapter_mode);
```

**回调函数示例：**
```c
static int my_event_handler(struct notifier_block *nb,
    unsigned long event, void *data)
{
    switch (event) {
    case POWER_NE_DC_CHECK_SUCC:
        hwlog_info("Direct charge check success\n");
        // 可以执行 I2C 操作、msleep 等
        msleep(100);
        update_ui_icon();
        break;
    
    case POWER_NE_DC_ADAPTER_MODE:
        int *mode = (int *)data;
        hwlog_info("Adapter mode = 0x%x\n", *mode);
        break;
    }
    return NOTIFY_OK;
}
```

### 2.2 Atomic Notifier Chain (ANC) - 原子通知链

**使用场景：** 中断上下文或需要极快响应的事件（如硬件故障）

**限制：**
- 回调函数不能睡眠（禁止 msleep、mutex_lock 等）
- 执行时间必须极短
- 通常用于设置标志位、触发工作队列

**内核机制：**
```c
static struct atomic_notifier_head g_power_event_anh[POWER_ANT_END];

void power_event_anc_init(void)
{
    for (i = 0; i < POWER_ANT_END; i++)
        ATOMIC_INIT_NOTIFIER_HEAD(&g_power_event_anh[i]);
}
```

**典型应用：**
```c
// 充电器故障中断处理
void charger_irq_handler(void)
{
    // 在中断上下文中发出原子事件
    power_event_anc_notify(POWER_ANT_CHARGE_FAULT, 
                           POWER_NE_CHG_FAULT_VBAT_OVP, 
                           NULL);
}

// 订阅者快速响应（不能睡眠）
static int fault_handler(struct notifier_block *nb,
    unsigned long event, void *data)
{
    switch (event) {
    case POWER_NE_CHG_FAULT_VBAT_OVP:
        // 仅设置标志位，不能调用 msleep
        g_ovp_flag = 1;
        schedule_work(&ovp_work);  // 调度工作队列处理
        break;
    }
    return NOTIFY_OK;
}
```

---

## 3. 事件类型体系

### 3.1 通知链类型（30种）

| 类型 | 常量名 | 用途 | 典型事件 |
|-----|--------|------|---------|
| **连接类** | POWER_BNT_CONNECT | USB/无线连接事件 | USB_CONNECT, WIRELESS_DISCONNECT |
| **充电类** | POWER_BNT_CHARGING | 充电状态变化 | CHARGING_START, CHARGING_STOP |
| **直充类** | POWER_BNT_DC | 直充模式事件 | DC_CHECK_SUCC, DC_LVC_CHARGING |
| **快充协议** | POWER_BNT_FCP | FCP 快充事件 | FCP_CHARGING_START |
| **无线充电** | POWER_BNT_WLC | 无线充电接收 | WLC_READY, WLC_AUTH_SUCC |
| **无线发射** | POWER_BNT_WLTX | 无线反向充电 | WLTX_PING_RX, WLTX_HANDSHAKE_SUCC |
| **OTG** | POWER_BNT_OTG | OTG 供电事件 | OTG_INSERT, OTG_OCP_HANDLE |
| **库仑计** | POWER_BNT_COUL | 电量计事件 | COUL_LOW_VOL |
| **PD** | POWER_BNT_HW_PD | PD 协议事件 | HW_PD_CHARGER, HW_PD_ORIENTATION_CC |
| **电池** | POWER_BNT_BATTERY | 电池状态事件 | BATTERY_LOW_WARNING, BATTERY_MOVE |
| **UI容量** | POWER_BNT_BAT_UI_CAPACITY | UI 电量变化 | BAT_UI_CAP_CHAGNED |
| **屏幕** | POWER_BNT_PANEL_EVENT | 屏幕开关事件 | PANEL_BLANK, PANEL_UNBLANK |

### 3.2 事件定义（200+ 种）

**按功能模块分类：**

#### 连接事件（8个）
```c
POWER_NE_USB_DISCONNECT          // USB 拔出
POWER_NE_USB_CONNECT             // USB 插入
POWER_NE_WIRELESS_DISCONNECT     // 无线充电断开
POWER_NE_WIRELESS_CONNECT        // 无线充电连接
POWER_NE_WIRELESS_TX_START       // 无线反向充电启动
POWER_NE_WIRELESS_TX_STOP        // 无线反向充电停止
POWER_NE_WIRELESS_AUX_TX_START   // 辅助无线发射启动（M-Pen/键盘）
POWER_NE_WIRELESS_AUX_TX_STOP    // 辅助无线发射停止
```

#### 充电状态事件（3个）
```c
POWER_NE_CHARGING_START          // 充电开始
POWER_NE_CHARGING_STOP           // 充电停止
POWER_NE_CHARGING_SUSPEND        // 充电暂停（温度保护等）
```

#### 直充事件（10个）
```c
POWER_NE_DC_CHECK_START          // 直充检测开始
POWER_NE_DC_CHECK_SUCC           // 直充检测成功
POWER_NE_DC_LVC_CHARGING         // LVC 模式充电中
POWER_NE_DC_SC_CHARGING          // SC 模式充电中
POWER_NE_DC_STOP_CHARGE          // 直充停止
POWER_NE_DC_PING_FAIL            // 适配器 PING 失败
POWER_NE_DC_ADAPTER_MODE         // 适配器能力上报
POWER_NE_DC_TEMP_ERR             // 温度异常
POWER_NE_DC_VOLTAGE_INVALID      // 电压异常
```

#### 故障事件（30+个）
```c
// 充电器故障
POWER_NE_CHG_FAULT_BOOST_OCP     // Boost OCP
POWER_NE_CHG_FAULT_VBAT_OVP      // 电池过压
POWER_NE_CHG_FAULT_WEAKSOURCE    // 弱源检测

// 直充故障
POWER_NE_DC_FAULT_VBUS_OVP       // VBUS 过压
POWER_NE_DC_FAULT_IBAT_OCP       // 电池过流
POWER_NE_DC_FAULT_OTP            // 过温保护
POWER_NE_DC_FAULT_CC_SHORT       // CC 短路
```

#### 无线充电事件（40+个）
```c
// 接收端
POWER_NE_WLRX_PWR_ON             // 无线充电上电
POWER_NE_WLRX_READY              // 准备就绪
POWER_NE_WLRX_OCP                // 过流保护

// 发射端
POWER_NE_WLTX_PING_RX            // 检测到接收设备
POWER_NE_WLTX_HANDSHAKE_SUCC     // 握手成功
POWER_NE_WLTX_CHARGEDONE         // 充电完成
POWER_NE_WLTX_HALL_APPROACH      // 霍尔检测靠近（M-Pen）
POWER_NE_WLTX_HALL_AWAY_FROM     // 霍尔检测远离
```

---

## 4. UEvent 用户空间通信

### 4.1 内核到用户空间事件传递

**机制：** 通过 kobject_uevent_env 发送 uevent 到用户空间

**Sysfs 节点：**
```
/sys/class/hw_power/power_event/
├── trigger        # 只写节点，用于手动触发事件
```

**内核发送 UEvent：**
```c
void power_event_report_uevent(const struct power_event_notify_data *n_data)
{
    char uevent_buf[1024] = { 0 };
    char *envp[] = { uevent_buf, NULL };
    
    // 构造环境变量字符串
    strcpy(uevent_buf, n_data->event);
    
    // 发送 uevent
    kobject_uevent_env(l_dev->sysfs_ne, KOBJ_CHANGE, envp);
}

// 使用示例
struct power_event_notify_data n_data = {
    .event = "CHARGER_TYPE=FCP",
    .event_len = 17,
};
power_event_report_uevent(&n_data);
```

**用户空间接收（Android）：**
```java
// PowerManagerService 监听 uevent
UEventObserver mPowerEventObserver = new UEventObserver() {
    @Override
    public void onUEvent(UEventObserver.UEvent event) {
        String chargerType = event.get("CHARGER_TYPE");
        if ("FCP".equals(chargerType)) {
            updateFastChargeIcon();
        }
    }
};

// 注册监听
mPowerEventObserver.startObserving("DEVPATH=/devices/platform/soc/hw_power/power_event");
```

### 4.2 手动触发事件（调试）

**用法：**
```bash
# 手动发送自定义事件到用户空间
echo "DEBUG_EVENT=test" > /sys/class/hw_power/power_event/trigger

# 触发同步事件
# power_event_sync() 内部调用
```

---

## 5. 典型应用场景

### 5.1 直充启动流程事件序列

```
时间轴              模块A（直充）           事件总线                模块B（充电管理）
─────────────────────────────────────────────────────────────────────────────
T0   插入适配器     
                    ↓
T1   开始检测  ─────→ POWER_NE_DC_CHECK_START ──→ 记录检测时间戳
                    ↓
T2   PING 成功
                    ↓
T3   检测成功  ─────→ POWER_NE_DC_CHECK_SUCC  ──→ 禁用 Buck 充电
                    ↓
T4   LVC 充电  ─────→ POWER_NE_DC_LVC_CHARGING ──→ 更新充电图标
                    ↓                              ↓
                    ↓                          上报 UEvent
                    ↓                              ↓
                    ↓                          用户空间更新 UI
T5   温度异常  ─────→ POWER_NE_DC_TEMP_ERR    ──→ 降低充电电流
                    ↓
T6   停止充电  ─────→ POWER_NE_DC_STOP_CHARGE ──→ 恢复 Buck 充电
```

### 5.2 低电关机场景

```c
// 库仑计模块检测到低电压
void coul_low_voltage_check(void)
{
    int vbat = get_battery_voltage();
    
    if (vbat < 3400) {  // 3.4V 关机阈值
        hwlog_info("Low voltage detected: %d mV\n", vbat);
        
        // 发送低电事件
        power_event_bnc_notify(POWER_BNT_COUL, 
                               POWER_NE_COUL_LOW_VOL, 
                               &vbat);
    }
}

// 电池管理模块订阅并处理
static int battery_event_handler(struct notifier_block *nb,
    unsigned long event, void *data)
{
    switch (event) {
    case POWER_NE_COUL_LOW_VOL:
        int *vbat = (int *)data;
        hwlog_err("Critical low voltage: %d mV\n", *vbat);
        
        // 上报用户空间触发关机
        struct power_event_notify_data n_data = {
            .event = "LOW_BATTERY_SHUTDOWN=1",
            .event_len = 24,
        };
        power_event_report_uevent(&n_data);
        break;
    }
    return NOTIFY_OK;
}
```

### 5.3 屏幕开关省电优化

```c
// Panel 模块发送屏幕状态事件
void panel_blank_notify(bool blank)
{
    if (blank) {
        power_event_bnc_notify(POWER_BNT_PANEL_EVENT, 
                               POWER_NE_PANEL_BLANK, 
                               NULL);
    } else {
        power_event_bnc_notify(POWER_BNT_PANEL_EVENT, 
                               POWER_NE_PANEL_UNBLANK, 
                               NULL);
    }
}

// 充电模块订阅并调整策略
static int charging_panel_handler(struct notifier_block *nb,
    unsigned long event, void *data)
{
    switch (event) {
    case POWER_NE_PANEL_BLANK:
        // 息屏后降低充电监控频率
        mod_delayed_work(system_wq, &charge_work, 
                         msecs_to_jiffies(10000)); // 10秒一次
        break;
    
    case POWER_NE_PANEL_UNBLANK:
        // 亮屏后提高监控频率
        mod_delayed_work(system_wq, &charge_work, 
                         msecs_to_jiffies(1000));  // 1秒一次
        break;
    }
    return NOTIFY_OK;
}
```

---

## 6. Power Extra Event 扩展模块

### 6.1 功能定位

**文件：** power_extra_event.c

**作用：** 处理特定平台的额外事件，主要用于不同屏幕驱动框架的适配。

**支持的屏幕客户端：**
```c
enum panel_client_type {
    PANEL_CLIENT_FB,        // FrameBuffer 框架（传统）
    PANEL_CLIENT_DRM_8425,  // DRM 框架（高通 8425）
};
```

### 6.2 DTS 配置

```dts
power_extra_event {
    compatible = "huawei,power_extra_event";
    status = "ok";
    panel_client = <1>;  // 0=FB, 1=DRM_8425
};
```

### 6.3 实现原理

```c
static int power_extra_event_probe(struct platform_device *pdev)
{
    // 解析 DTS 配置
    power_dts_read_u32(np, "panel_client", &di->panel_client, PANEL_CLIENT_FB);
    
    // 根据平台选择注册方式
    if (di->panel_client == PANEL_CLIENT_DRM_8425) {
        // DRM 框架：解析活动面板
        power_panel_event_parse_active_panel();
    }
    
    // 注册屏幕事件监听器
    power_panel_event_register(di);
}
```

---

## 7. 调试与监控

### 7.1 日志输出

**关键日志标签：** `power_event`

**典型日志：**
```bash
# 阻塞事件通知
[power_event] receive blocking event type=7 event=103,dc_lvc_charging

# 原子事件通知
[power_event] receive atomic event type=4 event=213,dc_fault_vbus_ovp

# UEvent 上报
[power_event] receive uevent_buf 24,LOW_BATTERY_SHUTDOWN=1
```

### 7.2 事件统计脚本

```bash
#!/bin/bash
# 统计最近 1 小时各类事件的触发次数

echo "=== Power Event Statistics ==="
dmesg | grep "power_event" | grep "receive blocking" | \
    awk '{print $(NF-1)}' | sort | uniq -c | sort -rn

echo ""
echo "=== Top 10 Events ==="
dmesg | grep "power_event" | grep -oP 'event=\d+,\K[^,]+' | \
    sort | uniq -c | sort -rn | head -10
```

### 7.3 实时监控工具

```bash
# 监控所有电源事件
logcat -s power_event | while read line; do
    echo "[$(date '+%H:%M:%S')] $line"
done

# 监控特定类型事件
dmesg -w | grep "power_event" | grep "dc_"
```

---

## 8. 设计模式与最佳实践

### 8.1 观察者模式应用

Power Event 是经典**观察者模式**的内核实现：

**角色映射：**
- **Subject（主题）**：`power_event_bnh` / `power_event_anh` 通知链数组
- **Observer（观察者）**：`notifier_block` 结构体
- **Notify（通知）**：`power_event_bnc_notify` / `power_event_anc_notify`

**优势：**
- 松耦合：发布者不需要知道订阅者是谁
- 动态订阅：运行时可随时注册/注销观察者
- 一对多：一个事件可通知多个订阅者

### 8.2 事件设计原则

**1. 事件粒度控制**
```c
// 好的设计：细粒度事件
POWER_NE_DC_LVC_CHARGING     // LVC 模式充电
POWER_NE_DC_SC_CHARGING      // SC 模式充电

// 不好的设计：粗粒度事件
POWER_NE_DC_CHARGING         // 无法区分模式
```

**2. 事件命名规范**
```
格式：POWER_NE_<模块>_<动作/状态>

示例：
POWER_NE_WLC_READY          // 无线充电_就绪
POWER_NE_WLTX_PING_RX       // 无线发射_检测接收器
POWER_NE_CHG_FAULT_VBAT_OVP // 充电器_故障_电池过压
```

**3. 数据传递规范**
```c
// 简单数据：直接传递指针
int adapter_mode = 0x16;
power_event_bnc_notify(type, event, &adapter_mode);

// 复杂数据：使用结构体
struct dc_error_info {
    int error_code;
    int ibat;
    int vbat;
};
struct dc_error_info info = {...};
power_event_bnc_notify(type, event, &info);

// 无数据：传递 NULL
power_event_bnc_notify(type, event, NULL);
```

### 8.3 订阅注册最佳实践

**模块初始化时注册：**
```c
static struct notifier_block my_nb = {
    .notifier_call = my_event_handler,
};

static int __init my_module_init(void)
{
    // 注册多个通知链
    power_event_bnc_register(POWER_BNT_DC, &my_nb);
    power_event_bnc_register(POWER_BNT_CHARGING, &my_nb);
    return 0;
}

static void __exit my_module_exit(void)
{
    // 模块卸载时注销
    power_event_bnc_unregister(POWER_BNT_DC, &my_nb);
    power_event_bnc_unregister(POWER_BNT_CHARGING, &my_nb);
}
```

**事件处理函数模板：**
```c
static int my_event_handler(struct notifier_block *nb,
    unsigned long event, void *data)
{
    // 1. 事件分类处理
    switch (event) {
    case POWER_NE_DC_CHECK_SUCC:
        handle_dc_check_succ(data);
        break;
    
    case POWER_NE_DC_TEMP_ERR:
        handle_temp_error(data);
        break;
    
    default:
        // 忽略未处理的事件
        break;
    }
    
    // 2. 必须返回 NOTIFY_OK
    return NOTIFY_OK;
}
```

---

## 9. 技术要点总结

### 9.1 核心功能

| 功能 | 实现机制 | 应用场景 |
|-----|---------|---------|
| **模块间通信** | 通知链（Notifier Chain） | 充电模块通知电池管理模块 |
| **内核到用户空间** | kobject_uevent_env | 更新充电图标、触发系统关机 |
| **阻塞通知** | blocking_notifier_chain | 允许睡眠的事件处理 |
| **原子通知** | atomic_notifier_chain | 中断上下文快速响应 |
| **事件同步** | power_event_sync | 确保用户空间事件同步 |

### 9.2 事件覆盖范围

```
连接事件（8种） + 充电事件（3种） + 直充事件（10种） + 
无线充电事件（40+种） + 故障事件（30+种） + 
PD事件（12种） + OTG事件（7种） + 其他（100+种）
────────────────────────────────────────────────
总计：200+ 种事件类型
```

### 9.3 设计优势

1. **解耦性**：发布者与订阅者完全解耦
2. **扩展性**：新增事件类型无需修改现有代码
3. **灵活性**：运行时动态注册/注销订阅
4. **高效性**：原子通知链支持中断上下文
5. **可靠性**：内核标准 notifier chain 机制保证稳定性

### 9.4 注意事项

1. **阻塞 vs 原子**：根据上下文选择正确的通知链类型
2. **事件命名**：遵循命名规范，避免冲突
3. **数据生命周期**：注意 data 指针的有效性
4. **返回值**：事件处理函数必须返回 `NOTIFY_OK`
5. **注销清理**：模块卸载时必须注销所有订阅
