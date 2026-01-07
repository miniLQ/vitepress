---
outline: deep
---


# VBUS监控 (vbus_monitor) 模块分析

## 一、模块概述

### 1.1 功能定位
`vbus_monitor` 是华为 MATE X5 的 **VBUS（充电总线）状态监控模块**，主要功能是：
- **连接状态管理**：统一管理USB/无线充电的连接/断开状态
- **VBUS缺失检测**：关机充电模式下监测VBUS异常掉电
- **Uevent通知**：向用户空间发送充电连接事件
- **Vote投票机制**：多客户端投票决策VBUS连接状态
- **无线TX监控**：监控无线反向充电（给其他设备充电）状态
- **Sysfs接口**：提供状态查询节点

### 1.2 核心概念
**VBUS**：充电总线电压，代表充电器是否在位
- USB充电：VBUS由USB充电器提供 (5V/9V/12V)
- 无线充电：VBUS由无线充电接收器提供
- 无线TX：手机给其他设备充电，消耗自身电量

### 1.3 设计目标
- **状态同步**：统一USB/无线充电状态通知机制
- **异常检测**：关机充电时VBUS掉电快速上报
- **投票管理**：多模块协同决策VBUS状态
- **用户通知**：通过uevent通知系统服务更新UI

---

## 二、核心架构

### 2.1 模块结构图
```
┌──────────────────────────────────────────────────────┐
│            vbus_monitor 监控模块                        │
├──────────────────────────────────────────────────────┤
│  初始化层                                              │
│  ├─ vbus_init: 创建vote对象 + sysfs节点               │
│  ├─ vbus_parse_dts: 解析absent_monitor配置            │
│  └─ power_event监听注册 (POWER_BNT_CONNECT)           │
├──────────────────────────────────────────────────────┤
│  事件处理层                                            │
│  ├─ vbus_notifier_call: 连接事件响应                  │
│  │   ├─ USB_CONNECT → uevent + vote(usb, true)       │
│  │   ├─ USB_DISCONNECT → uevent + vote(usb, false)   │
│  │   ├─ WIRELESS_CONNECT → uevent + vote(wl, true)   │
│  │   ├─ WIRELESS_DISCONNECT → uevent + vote(wl, false)│
│  │   ├─ WIRELESS_TX_START → TX_OPEN uevent           │
│  │   ├─ WIRELESS_TX_STOP → TX_CLOSE uevent           │
│  │   ├─ WIRELESS_AUX_TX_START → AUX_TX_OPEN          │
│  │   └─ WIRELESS_AUX_TX_STOP → AUX_TX_CLOSE          │
│  └─ vbus_vote_callback: Vote结果回调                  │
│      ├─ result=1 → VBUS_VOTE_CONNECT uevent          │
│      └─ result=0 → VBUS_VOTE_DISCONNECT uevent       │
├──────────────────────────────────────────────────────┤
│  VBUS缺失监测层                                        │
│  ├─ absent_monitor_work: 周期检测 (2s)                │
│  ├─ vbus_absent_monitor: VBUS状态判断                 │
│  │   ├─ 检查OVP开关状态                               │
│  │   ├─ 检查直充状态                                   │
│  │   ├─ 读取VBUS电压状态                              │
│  │   └─ absent_cnt计数 (连续5次异常)                  │
│  └─ vbus_send_absent_uevent: VBUS缺失通知             │
├──────────────────────────────────────────────────────┤
│  Uevent通知层                                         │
│  ├─ VBUS_CONNECT: 充电器连接                          │
│  ├─ VBUS_DISCONNECT: 充电器断开                       │
│  ├─ VBUS_ABSENT: 关机充电VBUS掉电                     │
│  ├─ VBUS_VOTE_CONNECT: Vote结果-连接                  │
│  ├─ VBUS_VOTE_DISCONNECT: Vote结果-断开               │
│  ├─ TX_OPEN: 无线反向充电开启                         │
│  ├─ TX_CLOSE: 无线反向充电关闭                        │
│  ├─ AUX_TX_OPEN: 辅助TX开启                           │
│  └─ AUX_TX_CLOSE: 辅助TX关闭                          │
├──────────────────────────────────────────────────────┤
│  Sysfs接口层                                          │
│  ├─ /sys/class/hw_power/vbus/absent_state (ro)       │
│  │   └─ 0: VBUS在位, 1: VBUS缺失                     │
│  └─ /sys/class/hw_power/vbus/connect_state (ro)      │
│      └─ -1: 默认, 0: 断开, 1: 连接                    │
└──────────────────────────────────────────────────────┘
```

### 2.2 事件流转图
```
充电器物理插入
    ↓
USB/Wireless驱动检测
    ↓
发送POWER_NE_USB_CONNECT / POWER_NE_WIRELESS_CONNECT
    ↓
vbus_notifier_call接收事件
    ↓
├─ vbus_send_connect_uevent
│  └─ 发送VBUS_CONNECT=到用户空间
│     └─ SystemUI更新充电图标
├─ power_vote_set(client, true, true)
│  └─ 投票客户端注册连接状态
│     └─ vbus_vote_callback触发
│        └─ 发送VBUS_VOTE_CONNECT=
└─ 更新 connect_state = VBUS_STATE_CONNECT
```

---

## 三、关键数据结构

### 3.1 设备管理结构
```c
struct vbus_dev {
	struct device *dev;                      // sysfs设备节点
	struct notifier_block nb;                // 事件通知块
	
	// VBUS缺失监测
	u32 absent_monitor_enabled;              // 监测使能 (DTS配置)
	struct delayed_work absent_monitor_work; // 周期监测任务 (2s)
	int absent_cnt;                          // 缺失计数器 (0-5)
	int absent_state;                        // 缺失状态 (0=在位, 1=缺失)
	
	// 连接状态管理
	int connect_state;                       // 连接状态 (-1=默认, 0=断开, 1=连接)
};
```

### 3.2 状态枚举
```c
// VBUS缺失状态
enum vbus_absent_state {
	VBUS_STATE_PRESENT = 0,  // VBUS正常在位
	VBUS_STATE_ABSENT = 1,   // VBUS异常缺失
};

// VBUS连接状态
enum vbus_connect_state {
	VBUS_DEFAULT_CONNECT_STATE = -1,  // 初始默认状态
	VBUS_STATE_DISCONNECT = 0,        // 充电器断开
	VBUS_STATE_CONNECT = 1,           // 充电器连接
};
```

### 3.3 Uevent事件定义
| Event字符串 | 含义 | 触发条件 |
|------------|------|---------|
| VBUS_CONNECT= | 充电器连接 | USB/无线充电器插入 |
| VBUS_DISCONNECT= | 充电器断开 | USB/无线充电器拔出 |
| VBUS_ABSENT= | VBUS缺失 | 关机充电时VBUS掉电 |
| VBUS_VOTE_CONNECT= | Vote连接 | 投票结果为连接 |
| VBUS_VOTE_DISCONNECT= | Vote断开 | 投票结果为断开 |
| TX_OPEN= | 无线TX开启 | 开始给其他设备充电 |
| TX_CLOSE= | 无线TX关闭 | 停止给其他设备充电 |
| AUX_TX_OPEN= | 辅助TX开启 | 辅助无线TX启动 |
| AUX_TX_CLOSE= | 辅助TX关闭 | 辅助无线TX停止 |

---

## 四、核心功能实现

### 4.1 连接事件处理
```c
static int vbus_notifier_call(struct notifier_block *nb,
	unsigned long event, void *data)
{
	struct vbus_dev *l_dev = vbus_get_dev();
	
	switch (event) {
	case POWER_NE_USB_DISCONNECT:
		// USB断开
		vbus_send_disconnect_uevent(l_dev);  // 发送uevent
		power_vote_set(VBUS_MONITOR_VOTE_OBJECT, "usb", false, false);  // 投票
		break;
		
	case POWER_NE_WIRELESS_DISCONNECT:
		// 无线充电断开
		vbus_send_disconnect_uevent(l_dev);
		power_vote_set(VBUS_MONITOR_VOTE_OBJECT, "wireless", false, false);
		break;
		
	case POWER_NE_USB_CONNECT:
		// USB连接
		vbus_send_connect_uevent(l_dev);
		power_vote_set(VBUS_MONITOR_VOTE_OBJECT, "usb", true, true);
		break;
		
	case POWER_NE_WIRELESS_CONNECT:
		// 无线充电连接
		vbus_send_connect_uevent(l_dev);
		power_vote_set(VBUS_MONITOR_VOTE_OBJECT, "wireless", true, true);
		break;
		
	case POWER_NE_WIRELESS_TX_START:
		// 无线反向充电开启
		vbus_send_wireless_tx_open_uevent();
		power_vote_set(VBUS_MONITOR_VOTE_OBJECT, "wireless_tx", true, true);
		break;
		
	case POWER_NE_WIRELESS_TX_STOP:
		// 无线反向充电停止
		vbus_send_wireless_tx_close_uevent();
		power_vote_set(VBUS_MONITOR_VOTE_OBJECT, "wireless_tx", false, false);
		break;
		
	// ... 辅助TX事件处理
	}
	
	return NOTIFY_OK;
}
```

### 4.2 Uevent去重机制
**问题**：重复发送相同事件会导致用户空间重复处理
**方案**：记录上次状态，过滤重复事件

```c
static void vbus_send_connect_uevent(struct vbus_dev *l_dev)
{
	// 检查是否与上次状态相同
	if (l_dev->connect_state == VBUS_STATE_CONNECT) {
		hwlog_info("ignore the same connect uevent\n");
		return;  // 忽略重复事件
	}
	
	// 更新状态
	l_dev->connect_state = VBUS_STATE_CONNECT;
	
	// 发送uevent
	n_data.event = "VBUS_CONNECT=";
	n_data.event_len = 13;
	power_event_report_uevent(&n_data);
}

static void vbus_send_disconnect_uevent(struct vbus_dev *l_dev)
{
	if (l_dev->connect_state == VBUS_STATE_DISCONNECT) {
		hwlog_info("ignore the same disconnect uevent\n");
		return;
	}
	
	l_dev->connect_state = VBUS_STATE_DISCONNECT;
	
	n_data.event = "VBUS_DISCONNECT=";
	n_data.event_len = 16;
	power_event_report_uevent(&n_data);
	
	// 同时清除接口就绪标志
	power_if_kernel_sysfs_set(POWER_IF_OP_TYPE_ALL, POWER_IF_SYSFS_READY, 0);
}
```

### 4.3 Vote投票机制
**目的**：多个客户端（USB/无线/无线TX）协同决策VBUS状态

**投票策略**：POWER_VOTE_SET_ANY（任一客户端投票即生效）
```
客户端投票:
- usb: true/false
- wireless: true/false
- wireless_tx: true/false
- wireless_aux_tx: true/false

Vote结果:
- 任一客户端投true → result=1 (连接)
- 全部客户端投false → result=0 (断开)
```

**Vote回调处理**：
```c
static int vbus_vote_callback(struct power_vote_object *obj,
	void *data, int result, const char *client_str)
{
	hwlog_info("result=%d client_str=%s\n", result, client_str);
	
	// result=1: 至少有一个客户端连接
	if (result)
		vbus_vote_send_connect_uevent();  // VBUS_VOTE_CONNECT=
	// result=0: 所有客户端断开
	else
		vbus_vote_send_disconnect_uevent();  // VBUS_VOTE_DISCONNECT=
	
	return 0;
}
```

**投票示例**：
```
初始状态:
usb=false, wireless=false, wireless_tx=false
→ vote_result=0 (断开)

USB充电器插入:
usb=true, wireless=false, wireless_tx=false
→ vote_result=1 (连接)
→ vbus_vote_send_connect_uevent()

同时无线充电:
usb=true, wireless=true, wireless_tx=false
→ vote_result=1 (保持连接)

拔掉USB，保留无线:
usb=false, wireless=true, wireless_tx=false
→ vote_result=1 (保持连接，不发送断开事件)

拔掉无线:
usb=false, wireless=false, wireless_tx=false
→ vote_result=0 (断开)
→ vbus_vote_send_disconnect_uevent()
```

### 4.4 VBUS缺失监测
**应用场景**：关机充电模式下，VBUS异常掉电需要快速通知系统

**监测逻辑**：
```c
static void vbus_absent_monitor(struct vbus_dev *l_dev)
{
	// 1. 检查是否需要监测
	// 条件1: OVP开关关闭 → 不监测
	if (power_sw_get_output_by_label(POWER_SW_CHARGER_OVP) == POWER_SW_OFF) {
		l_dev->absent_cnt = 0;
		return;
	}
	
	// 条件2: 处于直充阶段 → 不监测 (直充有自己的保护机制)
	if (power_platform_in_dc_charging_stage()) {
		l_dev->absent_cnt = 0;
		return;
	}
	
	// 2. 检测VBUS状态
	if (power_platform_get_vbus_status() == 0) {  // VBUS=0V (异常)
		l_dev->absent_state = VBUS_STATE_ABSENT;
		l_dev->absent_cnt++;  // 累加计数
	} else {  // VBUS正常
		l_dev->absent_state = VBUS_STATE_PRESENT;
		l_dev->absent_cnt = 0;  // 清零计数
	}
	
	hwlog_err("absent_monitor: state=%d, cnt=%d\n", 
		l_dev->absent_state, l_dev->absent_cnt);
	
	// 3. 连续5次检测到缺失 → 上报异常
	if (l_dev->absent_cnt < VBUS_ABSENT_MAX_CNTS)  // <5次
		return;
	
	vbus_send_absent_uevent(l_dev);  // 发送VBUS_ABSENT=
}
```

**监测流程**：
```
关机充电模式
    ↓
延迟4s启动监测 (absent_monitor_work)
    ↓
┌──────────────────────────────────────┐
│ 周期监测 (每2s一次)                    │
│  1. 检查OVP开关状态                    │
│  2. 检查是否直充                       │
│  3. 读取VBUS电压状态                   │
│  4. VBUS=0V → absent_cnt++            │
│     VBUS>0V → absent_cnt=0            │
│  5. absent_cnt≥5 (10s连续异常)        │
│     → 发送VBUS_ABSENT= uevent         │
│     → 系统处理充电器掉电事件            │
└──────────────────────────────────────┘
```

**异常判断标准**：
```
连续5次检测 × 2s间隔 = 10秒
→ 确保不是瞬时波动，而是真实掉电
```

### 4.5 周期监测任务
```c
static void vbus_absent_monitor_work(struct work_struct *work)
{
	struct vbus_dev *l_dev = vbus_get_dev();
	
	// 1. 检查使能状态
	if (!l_dev || !l_dev->absent_monitor_enabled)
		return;
	
	// 2. 仅在关机充电模式下监测
	if (!power_cmdline_is_powerdown_charging_mode())
		return;
	
	// 3. 执行VBUS缺失检测
	vbus_absent_monitor(l_dev);
	
	// 4. 重新调度下次检测 (2s后)
	schedule_delayed_work(&l_dev->absent_monitor_work,
		msecs_to_jiffies(VBUS_ABSENT_CHECK_TIME));  // 2000ms
}
```

**调度时机**：
```
系统启动 (vbus_init)
    ↓
延迟4s启动首次检测
    ↓
每2s周期执行
    ↓
直到模块卸载 (vbus_exit)
```

---

## 五、DTS配置示例

### 5.1 完整配置
```dts
huawei_vbus_monitor: huawei,vbus_monitor {
	compatible = "huawei,vbus_monitor";
	status = "ok";
	
	/* VBUS缺失监测使能
	 * 0: 禁用 (默认)
	 * 1: 启用 (关机充电模式下监测)
	 */
	absent_monitor_enabled = <1>;
};
```

### 5.2 参数说明
| 参数 | 含义 | 默认值 | 说明 |
|------|------|--------|------|
| absent_monitor_enabled | VBUS缺失监测使能 | 0 | 仅关机充电模式有效 |

### 5.3 使用场景
```
absent_monitor_enabled=0:
- 正常手机使用
- 不需要VBUS缺失检测
- 节省功耗

absent_monitor_enabled=1:
- 需要关机充电功能
- 监测充电器掉电
- 适用于工厂测试/售后维修
```

---

## 六、Sysfs接口

### 6.1 节点路径
```bash
/sys/class/hw_power/vbus/
├── absent_state    # VBUS缺失状态 (ro)
└── connect_state   # VBUS连接状态 (ro)
```

### 6.2 使用示例
```bash
# 查询VBUS缺失状态
cat /sys/class/hw_power/vbus/absent_state
# 输出:
# 0 - VBUS正常在位
# 1 - VBUS异常缺失

# 查询VBUS连接状态
cat /sys/class/hw_power/vbus/connect_state
# 输出:
# -1 - 默认初始状态
#  0 - 充电器断开
#  1 - 充电器连接

# Shell脚本监控示例
while true; do
    absent=$(cat /sys/class/hw_power/vbus/absent_state)
    connect=$(cat /sys/class/hw_power/vbus/connect_state)
    echo "VBUS: absent=$absent, connect=$connect"
    sleep 1
done
```

---

## 七、典型应用场景

### 7.1 USB充电器插拔
```
场景: 用户插入USB充电器

T=0s:    USB驱动检测到VBUS
         → 发送POWER_NE_USB_CONNECT事件
         
T=0.01s: vbus_notifier_call接收事件
         → vbus_send_connect_uevent
            → 发送VBUS_CONNECT= uevent
            → connect_state更新为1
         → power_vote_set("usb", true, true)
            → vbus_vote_callback(result=1)
            → 发送VBUS_VOTE_CONNECT= uevent
            
T=0.02s: 用户空间udev接收uevent
         → SystemUI更新充电图标
         → BatteryService更新充电状态
         
T=10s:   用户拔出USB充电器
         → 发送POWER_NE_USB_DISCONNECT事件
         → vbus_send_disconnect_uevent
            → 发送VBUS_DISCONNECT= uevent
            → connect_state更新为0
         → power_vote_set("usb", false, false)
            → vbus_vote_callback(result=0)
            → 发送VBUS_VOTE_DISCONNECT= uevent
```

### 7.2 无线充电 + USB同时充电
```
初始状态:
usb=false, wireless=false
→ vote_result=0

T=0s:    无线充电板放置手机
         → POWER_NE_WIRELESS_CONNECT
         → vote("wireless", true)
         → vote_result=1
         → VBUS_CONNECT= + VBUS_VOTE_CONNECT=

T=10s:   同时插入USB充电器
         → POWER_NE_USB_CONNECT
         → vote("usb", true)
         → vote_result=1 (保持不变)
         → VBUS_CONNECT= (connect_state已为1，被去重过滤)

T=20s:   拿起手机(无线充电断开)
         → POWER_NE_WIRELESS_DISCONNECT
         → vote("wireless", false)
         → vote_result=1 (USB仍连接)
         → VBUS_DISCONNECT= (connect_state已为1，被去重过滤)

T=30s:   拔出USB
         → POWER_NE_USB_DISCONNECT
         → vote("usb", false)
         → vote_result=0 (全部断开)
         → VBUS_DISCONNECT= + VBUS_VOTE_DISCONNECT=
```

### 7.3 无线反向充电
```
场景: 用户开启无线反向充电，给耳机充电

T=0s:    用户在设置中开启反向充电
         → 无线TX驱动启动
         → 发送POWER_NE_WIRELESS_TX_START事件
         
T=0.01s: vbus_notifier_call接收
         → vbus_send_wireless_tx_open_uevent
            → 发送TX_OPEN= uevent
         → power_vote_set("wireless_tx", true, true)
            → vote_result=1
            → VBUS_VOTE_CONNECT= (虽然是输出，但标记为"占用")
            
T=0.02s: SystemUI接收TX_OPEN= uevent
         → 显示反向充电动画
         → 更新电池消耗模式
         
T=60s:   耳机充满 / 用户关闭反向充电
         → POWER_NE_WIRELESS_TX_STOP
         → TX_CLOSE= uevent
         → vote("wireless_tx", false)
         → VBUS_VOTE_DISCONNECT=
```

### 7.4 关机充电VBUS掉电
```
场景: 关机充电模式下，充电器接触不良

T=0s:    系统进入关机充电模式
         → absent_monitor_enabled=1
         → 延迟4s启动监测
         
T=4s:    首次检测
         → VBUS=5V, absent_cnt=0
         
T=6s:    第2次检测
         → VBUS=5V, absent_cnt=0
         
T=30s:   充电器接触不良，VBUS掉电
         → VBUS=0V, absent_cnt=1
         
T=32s:   第2次异常
         → VBUS=0V, absent_cnt=2
         
T=34s:   第3次异常
         → VBUS=0V, absent_cnt=3
         
T=36s:   第4次异常
         → VBUS=0V, absent_cnt=4
         
T=38s:   第5次异常
         → VBUS=0V, absent_cnt=5
         → 触发阈值
         → vbus_send_absent_uevent()
         → 发送VBUS_ABSENT= uevent
         
T=38.01s: 用户空间init进程接收
          → 检测到充电器掉电
          → 执行关机流程
          → 防止长时间黑屏卡死
```

---

## 八、与其他模块协作

### 8.1 依赖接口
| 模块 | 接口 | 用途 |
|------|------|------|
| power_event | power_event_bnc_register | 监听连接事件 |
| power_event | power_event_report_uevent | 发送uevent通知 |
| power_vote | power_vote_create_object | 创建投票对象 |
| power_vote | power_vote_set | 设置投票值 |
| power_platform | power_platform_get_vbus_status | 获取VBUS状态 |
| power_platform | power_platform_in_dc_charging_stage | 查询直充状态 |
| power_sw | power_sw_get_output_by_label | 获取OVP开关状态 |
| power_cmdline | power_cmdline_is_powerdown_charging_mode | 查询关机充电模式 |
| power_if | power_if_kernel_sysfs_set | 设置接口就绪标志 |

### 8.2 事件流向
```
USB/Wireless驱动
    ↓ POWER_NE_*_CONNECT/DISCONNECT
vbus_notifier_call
    ↓
├─ vbus_send_*_uevent → 用户空间
│  └─ SystemUI更新UI
│  └─ BatteryService更新充电状态
└─ power_vote_set
   └─ vbus_vote_callback
      └─ VBUS_VOTE_* uevent → 用户空间
         └─ PowerManagerService决策
```

### 8.3 Vote客户端关系
```
VBUS_MONITOR_VOTE_OBJECT (SET_ANY策略)
├─ usb: USB充电投票
├─ wireless: 无线充电投票
├─ wireless_tx: 无线反向充电投票
└─ wireless_aux_tx: 辅助TX投票

Vote结果:
- 任一客户端=true → result=1 (VBUS占用)
- 全部客户端=false → result=0 (VBUS空闲)
```

---

## 九、Uevent处理

### 9.1 用户空间监听
**Android层接收**：
```java
// BatteryService.java
private final class BatteryListener extends UEventObserver {
    @Override
    public void onUEvent(UEventObserver.UEvent event) {
        String vbusConnect = event.get("VBUS_CONNECT");
        String vbusDisconnect = event.get("VBUS_DISCONNECT");
        String vbusAbsent = event.get("VBUS_ABSENT");
        String txOpen = event.get("TX_OPEN");
        
        if (vbusConnect != null) {
            // 充电器连接 → 更新充电状态
            updateBatteryStatus();
        } else if (vbusDisconnect != null) {
            // 充电器断开 → 停止充电动画
            stopChargingAnimation();
        } else if (vbusAbsent != null) {
            // VBUS缺失 → 关机充电模式下退出
            shutdownIfNeeded();
        } else if (txOpen != null) {
            // 反向充电开启 → 显示TX动画
            showWirelessTxAnimation();
        }
    }
}
```

### 9.2 事件汇总表
| Uevent | 触发条件 | 用户空间处理 |
|--------|---------|-------------|
| VBUS_CONNECT= | USB/无线充电器插入 | 更新充电UI、开始充电 |
| VBUS_DISCONNECT= | 充电器拔出 | 停止充电UI、清除就绪标志 |
| VBUS_ABSENT= | 关机充电VBUS掉电 | 关机退出 |
| VBUS_VOTE_CONNECT= | Vote结果连接 | PowerManager决策 |
| VBUS_VOTE_DISCONNECT= | Vote结果断开 | PowerManager决策 |
| TX_OPEN= | 无线反向充电开启 | 显示TX UI、限制性能 |
| TX_CLOSE= | 无线反向充电关闭 | 隐藏TX UI、恢复性能 |
| AUX_TX_OPEN= | 辅助TX开启 | 辅助TX UI |
| AUX_TX_CLOSE= | 辅助TX关闭 | 隐藏辅助TX UI |

---

## 十、关键技术要点

### 10.1 Uevent去重机制
**问题**：重复事件导致用户空间重复处理
```
USB插入 → VBUS_CONNECT=
USB识别为DCP → 再次触发连接事件 → VBUS_CONNECT= (重复!)
→ SystemUI重复播放充电动画
```

**解决方案**：记录connect_state状态
```c
if (l_dev->connect_state == VBUS_STATE_CONNECT) {
	return;  // 过滤重复的CONNECT事件
}
l_dev->connect_state = VBUS_STATE_CONNECT;
```

### 10.2 Vote投票策略
**SET_ANY策略**：任一客户端投票即生效
```
应用场景: VBUS占用判断
- USB充电中: usb=true → VBUS占用
- 无线充电中: wireless=true → VBUS占用
- 反向充电中: wireless_tx=true → VBUS占用 (实际是输出)
- 全部断开: 所有=false → VBUS空闲
```

**优势**：
- 统一管理多种充电模式
- 自动处理充电切换
- 避免状态冲突

### 10.3 关机充电保护
**场景**：关机充电时充电器接触不良
```
问题:
充电器松动 → VBUS间歇性掉电 → 系统无法检测 → 黑屏卡死

解决方案:
1. 周期监测VBUS电压 (2s)
2. 连续5次异常 (10s) → 确认掉电
3. 发送VBUS_ABSENT= uevent
4. init进程接收 → 执行关机
5. 防止长时间黑屏
```

### 10.4 接口就绪标志
```c
// 充电器断开时清除接口就绪标志
power_if_kernel_sysfs_set(POWER_IF_OP_TYPE_ALL, POWER_IF_SYSFS_READY, 0);
```

**目的**：通知其他模块充电接口不可用
```
充电器拔出 → VBUS_DISCONNECT
    ↓
power_if接口标记为未就绪
    ↓
其他模块查询接口状态
    ↓
发现未就绪 → 停止充电相关操作
    ↓
例如: 直充模块停止检测适配器
```

### 10.5 延迟启动机制
```c
// 系统启动4秒后再开始监测
schedule_delayed_work(&l_dev->absent_monitor_work,
	msecs_to_jiffies(VBUS_ABSENT_INIT_TIME));  // 4000ms
```

**原因**：
- 系统启动初期VBUS可能不稳定
- 充电IC初始化需要时间
- 避免误报VBUS缺失

---

## 十一、调试与诊断

### 11.1 日志输出
```bash
# 启用hwlog调试
echo "vbus_monitor" > /sys/kernel/debug/dynamic_debug/control

# 关键日志示例
[vbus_monitor] result=1 client_str=usb         # Vote结果: USB投票连接
[vbus_monitor] ignore the same connect uevent  # 过滤重复事件
[vbus_monitor] absent_monitor: state=1, cnt=5  # VBUS缺失检测
```

### 11.2 状态监控脚本
```bash
#!/bin/bash
# vbus_monitor_debug.sh

while true; do
    absent=$(cat /sys/class/hw_power/vbus/absent_state)
    connect=$(cat /sys/class/hw_power/vbus/connect_state)
    
    timestamp=$(date +"%H:%M:%S")
    echo "[$timestamp] VBUS: absent=$absent, connect=$connect"
    
    # 检测VBUS缺失
    if [ "$absent" == "1" ]; then
        echo "!!! VBUS ABSENT DETECTED !!!"
        dmesg | grep vbus_monitor | tail -20
    fi
    
    sleep 1
done
```

### 11.3 Uevent监听
```bash
# udevadm监听所有VBUS相关事件
udevadm monitor --environment | grep -E "VBUS|TX_"

# 输出示例:
# VBUS_CONNECT=
# VBUS_VOTE_CONNECT=
# TX_OPEN=
# TX_CLOSE=
# VBUS_DISCONNECT=
# VBUS_VOTE_DISCONNECT=
```

---

## 十二、总结

### 核心价值
1. **状态统一管理**：集中处理USB/无线/TX等多种充电模式
2. **Uevent通知**：向用户空间提供实时充电状态变化
3. **Vote投票机制**：多客户端协同决策VBUS占用状态
4. **关机充电保护**：检测VBUS掉电，防止黑屏卡死
5. **去重优化**：过滤重复事件，减少用户空间处理负担

### 技术亮点
- **Uevent去重**：connect_state状态记录避免重复通知
- **SET_ANY投票**：任一充电模式即标记VBUS占用
- **周期监测**：关机充电下2s周期检测VBUS
- **连续判定**：5次连续异常（10s）确认真实掉电
- **延迟启动**：4s延迟避免启动初期误报

### 适用场景
- **USB充电**：有线充电器插拔通知
- **无线充电**：无线充电板放置/移除
- **反向充电**：给其他设备充电状态管理
- **关机充电**：充电器掉电异常检测
- **多模式充电**：USB+无线同时充电协调

### 设计理念
- **事件驱动**：基于power_event通知链实现松耦合
- **状态机管理**：清晰的状态定义和转换
- **用户空间通知**：通过uevent实现内核-用户空间通信
- **投票决策**：多模块协同而非单一控制
- **安全保护**：关机充电异常处理防止系统卡死