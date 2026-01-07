---
outline: deep
---

# USB短路保护 (USCP) 模块分析

## 一、模块概述

### 1.1 功能定位
`uscp` (USB Short Circuit Protect) 是华为 MATE X5 的 **USB接口短路保护模块**，主要功能是：
- **短路检测**：通过温差算法检测USB接口短路故障
- **双重隔离**：MOSFET开关 + HIZ模式双重切断充电路径
- **智能监测**：充电初期高频监测 (300ms)，稳定后低频监测 (10s)
- **直充协同**：与直充系统联动，安全停止大功率充电
- **DMD上报**：短路事件自动上报故障码
- **唤醒锁保护**：短路期间持有wakelock防止系统休眠

### 1.2 核心原理
**短路检测算法**：USB接口短路时会产生异常发热，导致USB温度与电池温度差异剧增
```
正常充电: T_usb - T_bat ≤ 5-10°C
短路故障: T_usb - T_bat ≥ 15-25°C (快速升温)
```

### 1.3 设计目标
- **安全保护**：防止USB接口短路导致烧毁或起火
- **快速响应**：充电初期30秒密集检测，300ms一次
- **多级防护**：HIZ模式 + MOSFET开关 + 直充停止
- **用户无感**：正常充电时不影响性能，异常时自动处理

---

## 二、核心架构

### 2.1 模块结构图
```
┌────────────────────────────────────────────────────────┐
│             USCP 短路保护模块                             │
├────────────────────────────────────────────────────────┤
│  初始化层                                                │
│  ├─ probe: DTS解析 + GPIO配置                           │
│  ├─ uscp_check_enable: 温度合法性检查                    │
│  └─ power_event监听注册                                  │
├────────────────────────────────────────────────────────┤
│  事件管理层                                              │
│  ├─ notifier_call: 充电事件响应                         │
│  │   ├─ CHARGING_START → 延迟2s启动start_work           │
│  │   └─ CHARGING_STOP  → 延迟2s启动start_work           │
│  └─ start_work: 充电器类型判断 → 启动check_work          │
├────────────────────────────────────────────────────────┤
│  监测控制层 (check_work核心逻辑)                         │
│  ├─ 温度采集                                             │
│  │   ├─ uscp_get_usb_temp: USB接口温度                  │
│  │   ├─ uscp_get_bat_temp: 电池温度                     │
│  │   └─ diff_usb_bat: 计算温差                          │
│  ├─ 短路判断 (check_temperature)                        │
│  │   ├─ tusb≥40°C && tdiff≥open_hiz_temp → HIZ模式     │
│  │   └─ tusb≥40°C && tdiff≥open_mosfet_temp → 开MOSFET │
│  ├─ 监测频率调整 (set_interval)                         │
│  │   ├─ tdiff > switch_temp → 快速300ms                │
│  │   ├─ 充电前30s: 密集检测1100次                        │
│  │   └─ 稳定后: 慢速10s                                 │
│  └─ 保护执行 (process_protection)                       │
│      ├─ 启用HIZ模式                                      │
│      ├─ 停止直充 (DC)                                    │
│      ├─ 断开MOSFET                                       │
│      └─ 恢复充电路径                                      │
├────────────────────────────────────────────────────────┤
│  保护执行层                                              │
│  ├─ uscp_set_gpio_switch: 控制MOSFET (GPIO/Pinctrl)    │
│  ├─ power_platform_set_charge_hiz: 控制HIZ模式          │
│  └─ dc_set_adapter_output_enable: 关闭直充适配器        │
├────────────────────────────────────────────────────────┤
│  故障诊断层                                              │
│  ├─ uscp_dmd_report: DMD上报                            │
│  │   ├─ NTC异常 (温度超出-30~100°C)                     │
│  │   ├─ 短路保护 (MOSFET断开)                           │
│  │   └─ HIZ保护 (充电HIZ模式)                           │
│  └─ power_dbg接口: 运行时参数调试                        │
└────────────────────────────────────────────────────────┘
```

### 2.2 短路检测流程
```
充电启动事件
    ↓
延迟2s启动start_work
    ↓
判断充电器类型 (SDP/DCP/FCP/SCP/PD/TypeC)
    ↓
启动check_work周期任务
    ↓
┌──────────────────────────────────────────┐
│ 循环监测流程 (300ms/10s周期)               │
│  1. 采集温度: T_usb, T_bat               │
│  2. 计算温差: T_diff = T_usb - T_bat     │
│  3. 短路判断:                             │
│     if (T_usb≥40 && T_diff≥open_hiz)     │
│        → 启用HIZ模式 (轻微短路)           │
│     if (T_usb≥40 && T_diff≥open_mosfet)  │
│        → 停止直充 + 开MOSFET (严重短路)   │
│  4. 频率调整:                             │
│     if (T_diff > switch_temp)            │
│        → 300ms快速监测                    │
│     elif (充电前30s内)                    │
│        → 300ms密集监测1100次              │
│     else                                 │
│        → 10s慢速监测                      │
│  5. 恢复判断:                             │
│     if (T_diff ≤ close_mosfet_temp)      │
│        → 关闭MOSFET + 禁用HIZ             │
└──────────────────────────────────────────┘
    ↓
充电停止事件 → 清零状态 + 停止监测
```

---

## 三、关键数据结构

### 3.1 温度信息结构
```c
struct uscp_temp_info {
	int bat_temp;         // 电池温度 (°C)
	int usb_temp;         // USB接口温度 (°C)
	int diff_usb_bat;     // 温差 (°C)
};
```

### 3.2 设备管理结构
```c
struct uscp_device_info {
	// 工作队列
	struct delayed_work start_work;       // 启动延迟任务 (2s)
	struct delayed_work check_work;       // 周期检测任务
	
	// GPIO控制
	int gpio_uscp;                        // MOSFET控制GPIO
	bool use_pinctrl;                     // 是否使用Pinctrl
	
	// 温度阈值参数
	int uscp_threshold_tusb;              // USB温度阈值 (默认40°C)
	int open_mosfet_temp;                 // 开MOSFET温差阈值 (如15°C)
	int open_hiz_temp;                    // 开HIZ温差阈值 (如12°C)
	int close_mosfet_temp;                // 关MOSFET温差阈值 (如5°C)
	int interval_switch_temp;             // 切换快速监测温差 (如8°C)
	
	// 监测控制参数
	int check_interval;                   // 当前监测间隔 (300ms/10s/30s)
	int check_count;                      // 密集监测计数器 (1100→0)
	
	// 状态标志
	bool protect_enable;                  // 保护功能使能
	bool protect_mode;                    // 是否处于保护模式
	bool rt_protect_mode;                 // 实时保护模式 (对外接口)
	bool hiz_mode;                        // 是否处于HIZ模式
	bool first_in;                        // 首次检测标志
	bool dc_adapter;                      // 直充适配器状态
	
	// DMD上报控制
	int dmd_hiz_enable;                   // HIZ DMD使能
	bool dmd_notify_enable;               // MOSFET DMD使能
	bool dmd_notify_enable_hiz;           // HIZ DMD通知使能
	
	// 唤醒锁
	struct wakeup_source *protect_wakelock;
};
```

---

## 四、核心算法实现

### 4.1 温度差异算法
**原理**：USB短路时会在接口处产生异常热量，导致USB温度远高于电池温度

**算法逻辑**：
```c
// 1. 采集温度
usb_temp = power_temp_get_average_value(POWER_TEMP_USB_PORT) / 1000;
bat_temp = bat_temp_get_temperature(BAT_TEMP_MIXED);
diff_temp = usb_temp - bat_temp;

// 2. 短路判断 (多级保护)
if (usb_temp >= 40°C) {
	// 轻度短路: 启用HIZ模式限制充电
	if (diff_temp >= open_hiz_temp) {  // 如12°C
		enable_charge_hiz();
		dmd_report(HIZ_PROTECT);
	}
	
	// 重度短路: 完全断开充电路径
	if (diff_temp >= open_mosfet_temp) {  // 如15°C
		stop_direct_charge();      // 停止直充
		open_mosfet_switch();      // 断开MOSFET
		enable_charge_hiz();       // 启用HIZ
		hold_wakelock();           // 持有唤醒锁
		dmd_report(MOSFET_PROTECT);
	}
}

// 3. 恢复判断
if (diff_temp <= close_mosfet_temp) {  // 如5°C
	close_mosfet_switch();     // 闭合MOSFET
	disable_charge_hiz();      // 禁用HIZ
	release_wakelock();        // 释放唤醒锁
}
```

### 4.2 自适应监测频率
**目的**：充电初期高频监测快速响应，稳定后低频监测节省功耗

**算法示意**：
```
充电器插入
    ↓
count = 1100 (初始值)
    ↓
┌─────────────────────────────────┐
│ 前30秒密集监测阶段                │
│ 1100 → 1099 → ... → 1001        │
│ 每次-1，间隔300ms                │
│ 总共100次检测，耗时30秒           │
│ (1100-1001) × 300ms = 29.7s     │
└─────────────────────────────────┘
    ↓
count = 1001 (触发阈值)
    ↓
count = -1 (重置为默认)
    ↓
┌─────────────────────────────────┐
│ 稳定后慢速监测阶段                │
│ 间隔10s                          │
│ 节省功耗                          │
└─────────────────────────────────┘
    ↓
if (diff_temp > switch_temp)  // 温差升高
    ↓
count = 0 (重新启动快速监测)
    ↓
┌─────────────────────────────────┐
│ 异常快速监测阶段                  │
│ 间隔300ms                        │
│ 持续监测温度变化                  │
└─────────────────────────────────┘
```

**代码实现**：
```c
static void uscp_set_interval(struct uscp_device_info *di,
	struct uscp_temp_info *temp_info)
{
	int tdiff = temp_info->diff_usb_bat;
	
	// 温差异常 → 立即切换快速监测
	if (tdiff > di->interval_switch_temp) {
		di->check_interval = MONITOR_INTERVAL_FAST;  // 300ms
		di->check_count = CHECK_COUNT_START_VAL;     // 0
		return;
	}
	
	// 充电前30秒密集监测 (1100→1001)
	if (di->check_count > CHECK_COUNT_END_VAL) {  // >1001
		di->check_count -= CHECK_COUNT_STEP_VAL;  // -1
		di->check_interval = MONITOR_INTERVAL_FAST;  // 300ms
	}
	// 密集监测结束 → 切换慢速
	else if (di->check_count == CHECK_COUNT_END_VAL) {  // =1001
		di->check_count = CHECK_COUNT_DEFAULT_VAL;  // -1
		di->check_interval = MONITOR_INTERVAL_SLOW;  // 10s
	}
	// 温差升高后恢复正常 → 继续快速监测
	else if (di->check_count >= CHECK_COUNT_START_VAL) {  // ≥0
		di->check_count += CHECK_COUNT_STEP_VAL;  // +1
		di->check_interval = MONITOR_INTERVAL_FAST;  // 300ms
	}
	// 正常慢速监测
	else {
		di->check_interval = MONITOR_INTERVAL_SLOW;  // 10s
		di->protect_mode = false;
		power_wakeup_unlock(di->protect_wakelock, false);
	}
}
```

### 4.3 直充安全停止
**场景**：直充功率可达100W，短路时必须安全关闭避免危险

**流程**：
```c
// 1. 设置停止标志
dc_set_stop_charging_flag(true);

// 2. 等待直充完全停止
while (true) {
	state = direct_charge_get_stage_status();
	if (direct_charge_get_stop_charging_complete_flag() &&
	    ((state == DC_STAGE_DEFAULT) || (state == DC_STAGE_CHARGE_DONE)))
		break;
}

// 3. 清除停止标志
dc_set_stop_charging_flag(false);

// 4. 判断适配器类型 (首次检测)
if (di->first_in) {
	if (state == DC_STAGE_DEFAULT) {
		if (direct_charge_detect_adapter_again())
			uscp_set_dc_adapter(di, false);
		else
			uscp_set_dc_adapter(di, true);
	} else if (state == DC_STAGE_CHARGE_DONE) {
		uscp_set_dc_adapter(di, true);
	}
	di->first_in = false;
}

// 5. 关闭适配器输出
if (uscp_get_dc_adapter(di)) {
	ret = dc_set_adapter_output_enable(0);
	if (!ret) {
		uscp_set_dc_adapter(di, false);
		msleep(200);  // 等待适配器关闭
	}
}
```

### 4.4 MOSFET控制
**双模式支持**：GPIO直接控制 / Pinctrl间接控制

```c
static void uscp_set_gpio_switch(struct uscp_device_info *di, int value)
{
	// 模式1: 使用Pinctrl (推荐)
	if (di->use_pinctrl) {
		if (value == GPIO_SWITCH_OPEN)
			power_pinctrl_config_state(di->dev, "mos_en_on");
		else
			power_pinctrl_config_state(di->dev, "mos_en_off");
		return;
	}
	
	// 模式2: 直接GPIO控制
	gpio_set_value(di->gpio_uscp, value);
	// value=1: 拉高GPIO → 开MOSFET → 断开充电路径
	// value=0: 拉低GPIO → 关MOSFET → 闭合充电路径
}
```

---

## 五、DTS配置示例

### 5.1 完整配置
```dts
huawei_uscp: huawei,usb_short_circuit_protect {
	compatible = "huawei,usb_short_circuit_protect";
	status = "ok";
	
	/* USB温度阈值 (°C) */
	uscp_threshold_tusb = <40>;
	
	/* 温差阈值 (°C) */
	open_mosfet_temp = <15>;      // 开MOSFET温差 (重度短路)
	open_hiz_temp = <12>;          // 开HIZ温差 (轻度短路)
	close_mosfet_temp = <5>;       // 关MOSFET温差 (恢复正常)
	interval_switch_temp = <8>;    // 切换快速监测温差
	
	/* DMD配置 */
	dmd_hiz_enable = <1>;          // 使能HIZ模式DMD上报
	
	/* GPIO配置 (MOSFET控制) */
	gpio_usb_short_circuit_protect = <&gpio25 3 0>;
	
	/* Pinctrl配置 (可选，优先级高于GPIO) */
	use_pinctrl;
	pinctrl-names = "default", "mos_en_on", "mos_en_off";
	pinctrl-0 = <&gpio_uscp_default>;
	pinctrl-1 = <&gpio_uscp_high>;
	pinctrl-2 = <&gpio_uscp_low>;
};
```

### 5.2 参数说明
| 参数 | 含义 | 典型值 | 说明 |
|------|------|--------|------|
| uscp_threshold_tusb | USB温度阈值 | 40°C | 低于此温度不检测短路 |
| open_mosfet_temp | 开MOSFET温差 | 15-20°C | 重度短路保护 |
| open_hiz_temp | 开HIZ温差 | 12-15°C | 轻度短路保护 |
| close_mosfet_temp | 关MOSFET温差 | 5-8°C | 恢复正常充电 |
| interval_switch_temp | 切换快速监测温差 | 8-10°C | 触发快速监测 |
| dmd_hiz_enable | HIZ DMD使能 | 0/1 | 是否上报HIZ事件 |
| use_pinctrl | 使用Pinctrl | - | 优先使用Pinctrl控制MOSFET |

### 5.3 温差梯度设计
```
温差 (T_usb - T_bat)
  ↑
20°C┤                        (极端短路，快速断开)
    │
15°C┤───── open_mosfet ───── 断开MOSFET + HIZ
    │      
12°C┤───── open_hiz ───────── 仅HIZ模式
    │
10°C┤
    │
8°C ┤───── switch_temp ────── 切换快速监测 (300ms)
    │
5°C ┤───── close_mosfet ───── 恢复充电路径
    │
0°C ┤───── 正常充电 ──────────
    └──────────────────────────→ 时间
```

---

## 六、故障诊断

### 6.1 DMD上报类型
```c
enum dmd_error_type {
	// NTC异常: 温度超出-30~100°C范围
	POWER_DSM_ERROR_NO_USB_SHORT_PROTECT_NTC,
	
	// 短路保护: MOSFET断开
	POWER_DSM_ERROR_NO_USB_SHORT_PROTECT,
	
	// HIZ保护: 仅HIZ模式
	POWER_DSM_ERROR_NO_USB_SHORT_PROTECT_HIZ,
};
```

### 6.2 DMD上报内容
```c
// NTC异常
"uscp ntc error happened, tusb=105, tbatt=35"

// 短路保护 (MOSFET)
"uscp happened, tusb=55, tbatt=35"
// 解释: USB温度55°C，电池35°C，温差20°C触发MOSFET保护

// HIZ保护
"uscp happened, open hiz, tusb=50, tbatt=35"
// 解释: USB温度50°C，电池35°C，温差15°C触发HIZ保护
```

### 6.3 调试接口
**sysfs节点**：
```bash
# 查看当前参数
cat /sys/kernel/debug/power/uscp/para
# 输出:
# uscp_threshold_tusb=40
# open_mosfet_temp=15
# close_mosfet_temp=5
# interval_switch_temp=8

# 运行时调整参数 (格式: tusb open close switch)
echo "40 18 6 10" > /sys/kernel/debug/power/uscp/para
```

### 6.4 状态查询接口
```c
// 外部模块查询USCP状态
bool uscp_is_in_protect_mode(void);      // 是否处于保护模式
bool uscp_is_in_rt_protect_mode(void);   // 实时保护模式
bool uscp_is_in_hiz_mode(void);          // HIZ模式
```

---

## 七、典型应用场景

### 7.1 USB接口进水短路
**场景**：雨天充电，USB接口进水导致VCC与GND短路

**处理流程**：
```
T=0s:    充电器插入，启动监测
T=2s:    start_work启动，check_count=1100
T=2.3s:  第1次检测: T_usb=30°C, T_bat=28°C, diff=2°C (正常)
T=2.6s:  第2次检测: T_usb=35°C, T_bat=28°C, diff=7°C (升温)
T=2.9s:  第3次检测: T_usb=42°C, T_bat=28°C, diff=14°C
         → diff > switch_temp (8°C), 切换快速监测
         → T_usb≥40 && diff≥open_hiz (12°C)
         → 启用HIZ模式，上报DMD_HIZ
T=3.2s:  第4次检测: T_usb=48°C, T_bat=29°C, diff=19°C
         → T_usb≥40 && diff≥open_mosfet (15°C)
         → 停止直充 (如有)
         → 断开MOSFET
         → 持有wakelock
         → 上报DMD_MOSFET
T=3.5s:  第5次检测: T_usb=52°C (继续升温，但充电已停止)
T=60s:   用户拔出充电器，擦干USB接口
T=120s:  重新插入充电器
T=122s:  start_work启动
T=122.3s: T_usb=32°C, T_bat=30°C, diff=2°C
         → diff≤close_mosfet (5°C)
         → 闭合MOSFET，禁用HIZ，释放wakelock
         → 恢复正常充电
```

### 7.2 充电线内部短路
**场景**：劣质充电线内部绝缘层破损，间歇性短路

**表现**：
```
T=0s:    充电器插入，T_diff=3°C (正常)
T=30s:   密集监测结束，切换10s慢速监测
T=150s:  充电线弯折，内部短路，T_diff=12°C
         → 启用HIZ模式
         → 切换300ms快速监测
T=151s:  短路消失，T_diff=4°C
         → 禁用HIZ模式
         → 继续快速监测观察
T=180s:  温差稳定在3°C，恢复10s慢速监测
```

### 7.3 高温环境充电
**场景**：夏季车内温度50°C，电池温度45°C

**策略**：
```
T_usb=48°C, T_bat=45°C, diff=3°C
→ T_usb≥40°C 但 diff<open_hiz (12°C)
→ 不触发短路保护 (温差正常)
→ 正常充电，由temp_control模块限流
```

---

## 八、与其他模块协作

### 8.1 依赖接口
| 模块 | 接口 | 用途 |
|------|------|------|
| power_temp | power_temp_get_average_value | 获取USB接口温度 |
| battery_temp | bat_temp_get_temperature | 获取电池温度 |
| power_platform | power_platform_set_charge_hiz | 控制HIZ模式 |
| direct_charge | dc_set_stop_charging_flag | 停止直充 |
| direct_charge | dc_set_adapter_output_enable | 关闭适配器输出 |
| power_dsm | power_dsm_report_dmd | 上报DMD故障 |
| power_event | power_event_bnc_register | 监听充电事件 |
| power_wakeup | power_wakeup_lock | 持有唤醒锁 |

### 8.2 事件交互
```
charge_monitor (充电管理)
    ↓ POWER_NE_CHARGING_START
uscp_event_notifier_call
    ↓ 延迟2s
uscp_start_work
    ↓ 判断充电器类型
uscp_check_work (周期任务)
    ↓ 检测短路
uscp_process_protection
    ↓ 控制HIZ + MOSFET
power_platform / direct_charge (执行保护)
```

### 8.3 状态通知
```c
// USCP对外提供状态查询接口
extern bool uscp_is_in_protect_mode(void);
extern bool uscp_is_in_rt_protect_mode(void);
extern bool uscp_is_in_hiz_mode(void);

// 其他模块可查询USCP状态调整充电策略
if (uscp_is_in_hiz_mode()) {
	// HIZ模式下限制充电电流
	set_charge_current(500);  // 限流500mA
}
```

---

## 九、电源管理

### 9.1 Suspend处理
```c
static int uscp_suspend(struct platform_device *pdev, pm_message_t state)
{
	// 1. 取消所有延迟任务
	cancel_delayed_work_sync(&di->start_work);
	cancel_delayed_work_sync(&di->check_work);
	
	// 2. 保持保护状态 (MOSFET/HIZ状态不改变)
	// 目的: 系统休眠时继续保护，防止短路损坏
	
	return 0;
}
```

### 9.2 Resume处理
```c
static int uscp_resume(struct platform_device *pdev)
{
	unsigned int type = charge_get_charger_type();
	
	// 仅在充电器在位时恢复监测
	if (type == SDP || type == DCP || type == FCP || ...) {
		schedule_delayed_work(&di->check_work, 0);
	}
	
	return 0;
}
```

### 9.3 Wakelock策略
```c
// 短路保护期间持有唤醒锁
if (protect_mode) {
	power_wakeup_lock(di->protect_wakelock, false);
	// 目的: 防止系统休眠，确保监测温度恢复
}

// 温差恢复正常后释放
if (diff_temp <= close_mosfet_temp) {
	power_wakeup_unlock(di->protect_wakelock, false);
}
```

---

## 十、关键技术要点

### 10.1 温差算法优势
- **环境自适应**：通过温差判断，自动适应不同环境温度
- **误报率低**：正常高温充电（如夏天）不会误触发
- **灵敏度高**：短路导致的局部发热能快速检测

### 10.2 监测频率优化
```
充电阶段    监测间隔    持续时间    总检测次数    功耗
─────────────────────────────────────────────────
初始30s     300ms      30s         100次         高
稳定期      10s        长期        6次/分钟      低
异常期      300ms      持续异常    200次/分钟    高
```
**优势**：
- 初期密集监测快速响应
- 稳定后节省功耗
- 异常时自动加速

### 10.3 多级保护策略
```
短路程度            温差      保护措施                  风险等级
────────────────────────────────────────────────────────
正常充电            <5°C     无保护                    无
轻微异常            5-8°C    快速监测                  低
温度升高            8-12°C   快速监测 + HIZ模式         中
轻度短路            12-15°C  HIZ模式限流               中高
重度短路            >15°C    HIZ + MOSFET断开 + 停直充  高
```

### 10.4 直充安全机制
**问题**：直充功率高达100W，短路时必须安全停止
**方案**：
1. 设置停止标志 (防止重启)
2. 轮询等待直充完全停止
3. 关闭适配器输出
4. 延迟200ms确保断电
5. 断开MOSFET物理隔离

### 10.5 GPIO vs Pinctrl
```c
// 方案1: GPIO直接控制 (简单)
gpio_set_value(gpio_uscp, 1);  // 拉高GPIO

// 方案2: Pinctrl控制 (灵活，推荐)
power_pinctrl_config_state(dev, "mos_en_on");
// 优势:
// - 支持复杂引脚复用
// - 统一管理引脚状态
// - 减少GPIO资源占用
```

---

## 十一、故障排查指南

### 11.1 常见问题
**问题1**：正常充电时频繁触发短路保护
```
原因分析:
- 温差阈值设置过低 (open_mosfet_temp < 10°C)
- USB温度传感器异常 (读取偏高)
- 环境温度过高导致基线升高

解决方案:
1. 调高温差阈值: open_mosfet_temp=18°C
2. 校准USB温度传感器
3. 检查DMD记录确认实际温度
```

**问题2**：真实短路时未触发保护
```
原因分析:
- 温差阈值设置过高
- 监测频率过慢 (未在30s内检测到)
- MOSFET硬件故障

解决方案:
1. 降低温差阈值: open_mosfet_temp=12°C
2. 增加密集监测时间 (check_count=2000)
3. 检查MOSFET电路
```

**问题3**：短路保护后无法恢复充电
```
原因分析:
- close_mosfet_temp设置过低 (无法满足)
- 温度未真正回落
- MOSFET卡死在开路状态

解决方案:
1. 调高恢复阈值: close_mosfet_temp=8°C
2. 检查温度传感器读数
3. 重新初始化MOSFET GPIO
```

### 11.2 日志分析
```bash
# 正常充电日志
[uscp] handle charger_type=3
[uscp] start uscp check
[uscp] tusb=32, tbatt=30, tdiff=2
[uscp] diff_temp=2, switch_temp=8, interval=300, count=1099

# 短路保护日志
[uscp] tusb=50, tbatt=32, tdiff=18
[uscp] diff_temp=18, switch_temp=8, interval=300, count=0
[uscp] enable charge hiz
[uscp] disable adapter output success
[uscp] pull up mosfet
[uscp] uscp happened, tusb=50, tbatt=32

# 恢复充电日志
[uscp] tusb=35, tbatt=31, tdiff=4
[uscp] disable charge hiz and pull down mosfet
```

---

## 十二、总结

### 核心价值
1. **安全保护**：防止USB接口短路导致烧毁或起火
2. **智能监测**：自适应频率调整，兼顾响应速度与功耗
3. **多级防护**：HIZ + MOSFET + 直充停止三重保护
4. **环境自适应**：温差算法自动适应不同环境温度

### 技术亮点
- **温差算法**：通过USB-电池温差检测局部短路发热
- **自适应频率**：初期30s密集监测 → 稳定后10s慢速 → 异常时300ms快速
- **直充安全停止**：轮询等待 + 延迟确认，确保100W大功率安全停止
- **双重隔离**：HIZ模式(软件) + MOSFET开关(硬件)
- **Wakelock保护**：短路期间防止系统休眠，确保持续监测恢复

### 适用场景
- **进水短路**：雨天/水下充电接口进水
- **线材短路**：劣质充电线内部绝缘破损
- **异物短路**：USB接口内金属异物导通VCC-GND
- **高功率充电**：100W直充时的短路保护

### 设计哲学
- **预防为主**：充电初期30秒密集监测，快速发现隐患
- **分级响应**：轻度异常HIZ限流，重度短路完全断开
- **安全至上**：短路期间持有wakelock，确保持续保护
- **用户无感**：正常充电不影响性能，异常时自动处理