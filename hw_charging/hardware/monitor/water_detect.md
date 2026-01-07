---
outline: deep
---

# 进水检测框架 (water_detect) 模块分析

## 一、模块概述

### 1.1 功能定位
`water_detect` 是华为 MATE X5 的 **进水检测统一管理框架**，主要功能是：
- **检测方法抽象**：提供统一接口，支持多种进水检测技术
- **ops注册机制**：各检测驱动通过注册ops接入框架
- **事件驱动架构**：通过power_event触发检测
- **状态集中管理**：统一维护各检测点的进水状态
- **DMD/Uevent上报**：集中处理故障上报和用户通知
- **工作模式过滤**：关机充电/工厂模式下禁用检测

### 1.2 核心设计理念
**架构模式**：中间件/框架层
```
┌────────────────────────────────────────┐
│  应用层 (充电/音频/系统模块)              │
│  ↓ 查询进水状态                          │
├────────────────────────────────────────┤
│  water_detect 框架层 (本模块)            │
│  - ops管理                               │
│  - 事件分发                              │
│  - 状态汇总                              │
│  - DMD/Uevent上报                        │
│  ↓ 调用检测接口                          │
├────────────────────────────────────────┤
│  检测驱动层 (注册ops)                    │
│  - USB DP/DN (FSA9685/Scharger)        │
│  - USB ID (FSA4480)                    │
│  - USB GPIO (water_check模块)           │
│  - Audio DP/DN                          │
└────────────────────────────────────────┘
```

### 1.3 设计目标
- **解耦合**：检测方法与业务逻辑分离
- **可扩展**：新增检测方法只需注册ops
- **集中管理**：统一状态维护和上报接口
- **灵活配置**：DTS配置启用/禁用检测方法

---

## 二、核心架构

### 2.1 模块结构图
```
┌──────────────────────────────────────────────────────┐
│          water_detect 框架层                           │
├──────────────────────────────────────────────────────┤
│  初始化层                                              │
│  ├─ water_detect_init: 创建框架实例                   │
│  ├─ water_detect_parse_dts: 解析使能配置              │
│  └─ power_event监听注册 (POWER_BNT_WD)                │
├──────────────────────────────────────────────────────┤
│  Ops管理层                                            │
│  ├─ water_detect_ops_register                        │
│  │   ├─ 类型解析 (type_name → type)                  │
│  │   ├─ 存储ops[type]                                │
│  │   └─ total_ops计数                                │
│  └─ 支持4种检测类型:                                  │
│      ├─ WD_TYPE_USB_DP_DN                            │
│      ├─ WD_TYPE_USB_ID                               │
│      ├─ WD_TYPE_USB_GPIO                             │
│      └─ WD_TYPE_AUDIO_DP_DN                          │
├──────────────────────────────────────────────────────┤
│  事件处理层                                            │
│  ├─ water_detect_notifier_call                       │
│  │   ├─ POWER_NE_WD_DETECT_BY_* → 触发检测            │
│  │   ├─ POWER_NE_WD_REPORT_DMD → DMD上报             │
│  │   └─ POWER_NE_WD_REPORT_UEVENT → Uevent上报       │
│  └─ water_detect_monitor (检测执行)                   │
│      ├─ 检查工作模式 (关机充电/工厂模式禁用)           │
│      ├─ 调用ops->is_water_intruded()                 │
│      ├─ 更新status状态位图                            │
│      └─ 触发DMD + Uevent上报                          │
├──────────────────────────────────────────────────────┤
│  状态管理层                                            │
│  ├─ status: 位图 (bit0-3对应4种检测类型)              │
│  │   ├─ bit=1: 对应类型检测到进水                     │
│  │   └─ bit=0: 对应类型未检测到进水                   │
│  ├─ water_detect_set_intruded_status                 │
│  │   ├─ WD_OP_SET: status |= (1 << type)            │
│  │   └─ WD_OP_CLR: status &= ~(1 << type)           │
│  └─ water_detect_get_intruded_status (对外接口)       │
│      └─ return (status > 0) ? true : false           │
├──────────────────────────────────────────────────────┤
│  上报层                                               │
│  ├─ water_detect_report_dmd                          │
│  │   └─ DMD: POWER_DSM_ERROR_NO_WATER_CHECK_IN_USB   │
│  └─ water_detect_report_uevent                       │
│      └─ POWER_UI_NE_WATER_STATUS                     │
└──────────────────────────────────────────────────────┘
```

### 2.2 工作流程
```
系统启动
    ↓
water_detect_init
    ├─ 创建框架实例
    ├─ 解析DTS使能配置
    └─ 注册power_event监听
    ↓
各检测驱动加载
    ├─ FSA9685: water_detect_ops_register(&usb_dp_dn_ops)
    ├─ FSA4480: water_detect_ops_register(&usb_id_ops)
    ├─ water_check: water_detect_ops_register(&usb_gpio_ops)
    └─ Audio: water_detect_ops_register(&audio_dp_dn_ops)
    ↓
运行时检测触发
    ├─ USB插入 → POWER_NE_WD_DETECT_BY_USB_DP_DN
    ├─ USB ID变化 → POWER_NE_WD_DETECT_BY_USB_ID
    ├─ GPIO中断 → POWER_NE_WD_DETECT_BY_USB_GPIO
    └─ 音频插入 → POWER_NE_WD_DETECT_BY_AUDIO_DP_DN
    ↓
water_detect_notifier_call
    ├─ 检查使能配置 (enable.usb_dp_dn等)
    └─ 调用water_detect_monitor
    ↓
water_detect_monitor
    ├─ 检查工作模式 (关机充电/工厂模式→跳过)
    ├─ 调用ops[type]->is_water_intruded()
    ├─ 进水: status |= (1 << type)
    │   ├─ report_uevent(WD_NON_STBY_MOIST)
    │   └─ report_dmd(type_name)
    └─ 干燥: status &= ~(1 << type)
    ↓
应用层查询
    └─ water_detect_get_intruded_status() → true/false
```

---

## 三、关键数据结构

### 3.1 检测类型枚举
```c
enum water_detect_type {
	WD_TYPE_BEGIN = 0,
	WD_TYPE_USB_DP_DN = 0,  // USB D+/D- 检测 (如FSA9685/Scharger)
	WD_TYPE_USB_ID,         // USB ID引脚检测 (如FSA4480)
	WD_TYPE_USB_GPIO,       // USB GPIO检测 (如water_check模块)
	WD_TYPE_AUDIO_DP_DN,    // 音频D+/D- 检测
	WD_TYPE_END,            // 共4种类型
};
```

### 3.2 Ops操作接口
```c
struct water_detect_ops {
	const char *type_name;              // 类型名称 (如"usb_dp_dn")
	void *dev_data;                     // 设备私有数据
	int (*is_water_intruded)(void *);   // 检测接口: 返回1=进水, 0=干燥
};
```

### 3.3 使能配置
```c
struct water_detect_enable {
	unsigned int usb_dp_dn;     // USB D+/D- 检测使能 (0/1)
	unsigned int usb_id;        // USB ID检测使能 (0/1)
	unsigned int usb_gpio;      // USB GPIO检测使能 (0/1)
	unsigned int audio_dp_dn;   // 音频检测使能 (0/1)
};
```

### 3.4 框架设备结构
```c
struct water_detect_dev {
	struct notifier_block nb;             // power_event通知块
	struct water_detect_enable enable;    // 各检测类型使能配置
	struct water_detect_ops *ops[4];      // ops数组 (4种检测类型)
	unsigned int total_ops;               // 已注册ops数量
	unsigned int status;                  // 进水状态位图
	// status位图定义:
	// bit0: USB_DP_DN进水状态
	// bit1: USB_ID进水状态
	// bit2: USB_GPIO进水状态
	// bit3: AUDIO_DP_DN进水状态
};
```

### 3.5 进水状态枚举
```c
enum water_detect_intruded_status {
	WD_NON_STBY_DRY,     // 非待机模式-干燥
	WD_NON_STBY_MOIST,   // 非待机模式-进水
	WD_STBY_DRY,         // 待机模式-干燥
	WD_STBY_MOIST,       // 待机模式-进水
};
```

---

## 四、核心功能实现

### 4.1 Ops注册机制
```c
int water_detect_ops_register(struct water_detect_ops *ops)
{
	int type;
	
	// 1. 参数检查
	if (!g_water_detect_dev || !ops || !ops->type_name)
		return -EPERM;
	
	// 2. 类型名称解析 (字符串 → 枚举)
	type = water_detect_get_type(ops->type_name);
	// "usb_dp_dn" → WD_TYPE_USB_DP_DN (0)
	// "usb_id"    → WD_TYPE_USB_ID (1)
	// "usb_gpio"  → WD_TYPE_USB_GPIO (2)
	// "audio_dp_dn" → WD_TYPE_AUDIO_DP_DN (3)
	if (type < 0)
		return -EPERM;
	
	// 3. 存储ops指针
	g_water_detect_dev->ops[type] = ops;
	
	// 4. 计数器递增
	g_water_detect_dev->total_ops++;
	
	hwlog_info("total_ops=%d type=%d:%s ops register ok\n",
		total_ops, type, ops->type_name);
	
	return 0;
}
```

**注册示例**：
```c
// FSA9685驱动注册USB DP/DN检测
static struct water_detect_ops fsa9685_water_ops = {
	.type_name = "usb_dp_dn",
	.dev_data = &fsa9685_dev,
	.is_water_intruded = fsa9685_is_water_intruded,
};
water_detect_ops_register(&fsa9685_water_ops);

// water_check模块注册USB GPIO检测
static struct water_detect_ops usb_gpio_water_ops = {
	.type_name = "usb_gpio",
	.dev_data = &water_check_dev,
	.is_water_intruded = usb_gpio_is_water_intruded,
};
water_detect_ops_register(&usb_gpio_water_ops);
```

### 4.2 检测执行
```c
static void water_detect_monitor(struct water_detect_dev *l_dev,
	enum water_detect_type type)
{
	struct water_detect_ops *l_ops = NULL;
	
	// 1. 类型检查
	if (water_detect_check_type(type))  // 0 ≤ type < 4
		return;
	
	// 2. 工作模式检查
	if (water_detect_is_disabled(l_dev))
		return;  // 关机充电/工厂模式禁用
	
	// 3. 获取ops接口
	l_ops = l_dev->ops[type];
	if (!l_ops || !l_ops->is_water_intruded)
		return;
	
	// 4. 调用检测接口
	if (l_ops->is_water_intruded(l_ops->dev_data)) {
		// 检测到进水
		water_detect_set_intruded_status(WD_OP_SET, type);
		// status |= (1 << type)
		
		water_detect_report_uevent(WD_NON_STBY_MOIST);
		water_detect_report_dmd(water_detect_get_type_name(type));
	} else {
		// 未检测到进水
		water_detect_set_intruded_status(WD_OP_CLR, type);
		// status &= ~(1 << type)
	}
}
```

### 4.3 状态管理 - 位图操作
```c
// 设置/清除进水状态
static void water_detect_set_intruded_status(unsigned int mode, 
	unsigned int type)
{
	struct water_detect_dev *l_dev = water_detect_get_dev();
	
	if (mode == WD_OP_SET)
		l_dev->status |= (1 << type);   // 置位
	if (mode == WD_OP_CLR)
		l_dev->status &= (~(1 << type)); // 清位
}

// 查询进水状态 (对外接口)
bool water_detect_get_intruded_status(void)
{
	struct water_detect_dev *l_dev = water_detect_get_dev();
	
	// 任一位为1 → 返回true (有进水)
	return (l_dev->status > 0) ? true : false;
}
```

**状态位图示例**：
```
初始状态: status = 0b0000 (全部干燥)

USB_DP_DN检测到进水:
status |= (1 << 0) → 0b0001

USB_GPIO检测到进水:
status |= (1 << 2) → 0b0101

查询进水状态:
water_detect_get_intruded_status() → true (status=0b0101 > 0)

USB_DP_DN恢复干燥:
status &= ~(1 << 0) → 0b0100

查询进水状态:
water_detect_get_intruded_status() → true (status=0b0100 > 0, USB_GPIO仍进水)

USB_GPIO恢复干燥:
status &= ~(1 << 2) → 0b0000

查询进水状态:
water_detect_get_intruded_status() → false (status=0 全部干燥)
```

### 4.4 工作模式过滤
```c
static bool water_detect_is_disabled(struct water_detect_dev *l_dev)
{
	// 关机充电模式禁用
	if (power_cmdline_is_powerdown_charging_mode()) {
		hwlog_info("water detect disabled on pd charging mode\n");
		return true;
	}
	
	// 工厂模式禁用
	if (power_cmdline_is_factory_mode()) {
		hwlog_info("water detect disabled on factory mode\n");
		return true;
	}
	
	return false;
}
```

**禁用原因**：
- **关机充电**：系统简化运行，减少复杂检测
- **工厂模式**：产线测试可能触发误报，影响生产

### 4.5 事件处理
```c
static int water_detect_notifier_call(struct notifier_block *nb,
	unsigned long event, void *data)
{
	struct water_detect_dev *l_dev = water_detect_get_dev();
	
	switch (event) {
	case POWER_NE_WD_REPORT_DMD:
		// 外部模块请求DMD上报
		water_detect_report_dmd((char *)data);
		break;
		
	case POWER_NE_WD_REPORT_UEVENT:
		// 外部模块请求Uevent上报
		water_detect_report_uevent(*(unsigned int *)data);
		break;
		
	case POWER_NE_WD_DETECT_BY_USB_DP_DN:
		// 触发USB D+/D- 检测
		if (l_dev->enable.usb_dp_dn)
			water_detect_monitor(l_dev, WD_TYPE_USB_DP_DN);
		break;
		
	case POWER_NE_WD_DETECT_BY_USB_ID:
		// 触发USB ID检测
		if (l_dev->enable.usb_id)
			water_detect_monitor(l_dev, WD_TYPE_USB_ID);
		break;
		
	case POWER_NE_WD_DETECT_BY_USB_GPIO:
		// 触发USB GPIO检测
		if (l_dev->enable.usb_gpio)
			water_detect_monitor(l_dev, WD_TYPE_USB_GPIO);
		break;
		
	case POWER_NE_WD_DETECT_BY_AUDIO_DP_DN:
		// 触发音频检测
		if (l_dev->enable.audio_dp_dn)
			water_detect_monitor(l_dev, WD_TYPE_AUDIO_DP_DN);
		break;
	}
	
	return NOTIFY_OK;
}
```

### 4.6 DMD上报
```c
static void water_detect_report_dmd(const char *buf)
{
	char dsm_buff[128] = { 0 };
	
	if (buf)
		snprintf(dsm_buff, 127, "water check is triggered : %s\n", buf);
	else
		snprintf(dsm_buff, 127, "water check is triggered\n");
	
	power_dsm_report_dmd(POWER_DSM_BATTERY,
		POWER_DSM_ERROR_NO_WATER_CHECK_IN_USB, dsm_buff);
}
```

**DMD内容示例**：
```
DMD_NO: 926002xxx
Content: water check is triggered : usb_dp_dn
```

### 4.7 Uevent上报
```c
static void water_detect_report_uevent(unsigned int flag)
{
	int data = flag;
	
	power_ui_event_notify(POWER_UI_NE_WATER_STATUS, &data);
}
```

**Uevent用途**：
- 通知SystemUI显示进水警告
- 通知充电模块禁止充电
- 更新设置菜单进水状态

---

## 五、DTS配置示例

### 5.1 完整配置
```dts
huawei_charger: huawei,charger {
	compatible = "huawei,charger";
	status = "ok";
	
	/* 进水检测使能配置
	 * 0: 禁用
	 * 1: 启用
	 */
	
	// USB D+/D- 检测 (FSA9685/Scharger芯片)
	wd_by_usb_dp_dn = <1>;
	
	// USB ID引脚检测 (FSA4480芯片)
	wd_by_usb_id = <1>;
	
	// USB GPIO检测 (water_check模块)
	wd_by_usb_gpio = <1>;
	
	// 音频D+/D- 检测
	wd_by_audio_dp_dn = <0>;  // 禁用
};
```

### 5.2 配置策略
| 检测类型 | 芯片依赖 | 推荐配置 | 说明 |
|---------|---------|---------|------|
| usb_dp_dn | FSA9685/Scharger | 1 | USB充电芯片集成检测 |
| usb_id | FSA4480 | 1 | TypeC芯片ID检测 |
| usb_gpio | water_check模块 | 1 | 独立GPIO检测 |
| audio_dp_dn | Audio芯片 | 0/1 | 根据是否有耳机孔 |

### 5.3 多检测方法组合
**策略1：单一检测**
```dts
wd_by_usb_dp_dn = <1>;  // 仅使用充电芯片检测
wd_by_usb_id = <0>;
wd_by_usb_gpio = <0>;
```

**策略2：双重检测**
```dts
wd_by_usb_dp_dn = <1>;  // 充电芯片检测
wd_by_usb_gpio = <1>;   // GPIO独立检测
// 双重保险，提高可靠性
```

**策略3：全方位检测**
```dts
wd_by_usb_dp_dn = <1>;
wd_by_usb_id = <1>;
wd_by_usb_gpio = <1>;
wd_by_audio_dp_dn = <1>;
// 覆盖USB+音频，最大化保护
```

---

## 六、典型应用场景

### 6.1 USB进水检测 - 多方法协同
```
用户插入USB充电器，接口有水分

T=0ms:     USB物理插入
           
T=10ms:    FSA9685芯片检测D+/D-阻抗异常
           → power_event_notify(POWER_NE_WD_DETECT_BY_USB_DP_DN)
           → water_detect_notifier_call
           → water_detect_monitor(WD_TYPE_USB_DP_DN)
           → fsa9685_ops->is_water_intruded() → 返回1 (进水)
           → status |= 0b0001
           → report_uevent(WD_NON_STBY_MOIST)
           → report_dmd("usb_dp_dn")
           
T=20ms:    water_check模块GPIO检测
           → power_event_notify(POWER_NE_WD_DETECT_BY_USB_GPIO)
           → water_detect_monitor(WD_TYPE_USB_GPIO)
           → usb_gpio_ops->is_water_intruded() → 返回1 (进水)
           → status |= 0b0100
           → report_uevent(WD_NON_STBY_MOIST)
           → report_dmd("usb_gpio")
           
T=30ms:    充电模块查询进水状态
           → water_detect_get_intruded_status() → true
           → 禁止充电
           → 显示进水警告: "USB接口检测到液体，请擦干后充电"
           
T=10min:   用户擦干USB接口
           → FSA9685再次检测: 返回0 (干燥)
           → status &= ~0b0001 → status=0b0100
           → GPIO仍检测到微量水分
           → 仍禁止充电
           
T=20min:   水分完全蒸发
           → GPIO检测: 返回0 (干燥)
           → status &= ~0b0100 → status=0b0000
           → water_detect_get_intruded_status() → false
           → 允许充电
```

### 6.2 工厂模式跳过检测
```
产线测试场景

T=0s:      设备进入工厂模式
           → power_cmdline_is_factory_mode() → true
           
T=1s:      测试人员插入USB
           → POWER_NE_WD_DETECT_BY_USB_DP_DN
           → water_detect_monitor
           → water_detect_is_disabled() → true
           → 直接返回，不执行检测
           
T=2s:      测试充电功能
           → water_detect_get_intruded_status() → false
           → 允许充电测试
           → 避免环境湿度导致测试失败
```

### 6.3 多检测方法冗余
```
极端场景: FSA9685芯片故障

T=0s:      USB进水
           
T=0.01s:   FSA9685检测 (芯片故障)
           → is_water_intruded() → 返回0 (误判为干燥)
           → status保持0b0000
           
T=0.02s:   USB_GPIO检测 (正常工作)
           → is_water_intruded() → 返回1 (正确检测)
           → status |= 0b0100
           
T=0.03s:   充电模块查询
           → water_detect_get_intruded_status() → true
           → 成功禁止充电
           → 冗余设计避免单点故障
```

---

## 七、与其他模块协作

### 7.1 检测驱动注册
```
FSA9685/Scharger驱动:
→ water_detect_ops_register(&usb_dp_dn_ops)
→ ops[WD_TYPE_USB_DP_DN] = &usb_dp_dn_ops

FSA4480驱动:
→ water_detect_ops_register(&usb_id_ops)
→ ops[WD_TYPE_USB_ID] = &usb_id_ops

water_check模块:
→ water_detect_ops_register(&usb_gpio_ops)
→ ops[WD_TYPE_USB_GPIO] = &usb_gpio_ops
```

### 7.2 检测触发流程
```
USB驱动 (检测到插入)
    ↓
power_event_notify(POWER_NE_WD_DETECT_BY_USB_DP_DN)
    ↓
water_detect_notifier_call
    ↓
water_detect_monitor(WD_TYPE_USB_DP_DN)
    ↓
ops[WD_TYPE_USB_DP_DN]->is_water_intruded()
    ↓
FSA9685驱动检测函数
    └─ 读取寄存器
    └─ 判断阻抗/电容
    └─ 返回 1(进水) / 0(干燥)
```

### 7.3 状态查询
```c
// 充电模块查询
bool is_water = water_detect_get_intruded_status();
if (is_water) {
	disable_charging();
	show_water_warning();
}

// 音频模块查询
bool is_water = water_detect_get_intruded_status();
if (is_water) {
	disable_headphone_detection();
	protect_audio_codec();
}
```

### 7.4 依赖接口
| 模块 | 接口 | 用途 |
|------|------|------|
| power_event | power_event_bnc_register | 监听进水检测事件 |
| power_dsm | power_dsm_report_dmd | 上报DMD故障 |
| power_ui | power_ui_event_notify | 通知UI显示进水状态 |
| power_cmdline | power_cmdline_is_* | 查询工作模式 |
| power_dts | power_dts_read_u32_compatible | 解析DTS配置 |

---

## 八、关键技术要点

### 8.1 Ops注册机制
**优势**：
- 解耦：框架与检测实现分离
- 可扩展：新增检测方法无需修改框架
- 统一管理：集中维护状态和上报

**实现**：
```c
// 框架层
struct water_detect_ops *ops[4];  // 存储各类型ops

// 检测驱动层
static struct water_detect_ops my_ops = {
	.type_name = "usb_dp_dn",
	.is_water_intruded = my_detect_func,
};
water_detect_ops_register(&my_ops);  // 注册到框架
```

### 8.2 位图状态管理
**位图设计**：
```c
unsigned int status;  // 32位，当前使用4位
// bit0: USB_DP_DN
// bit1: USB_ID
// bit2: USB_GPIO
// bit3: AUDIO_DP_DN
```

**优势**：
- 节省内存 (4个bool → 4个bit)
- 原子操作 (位运算)
- 快速查询 (status > 0)

### 8.3 事件驱动架构
```
事件源 → power_event_notify → water_detect_notifier → 检测执行
```

**优势**：
- 松耦合：事件源与检测逻辑分离
- 灵活触发：任何模块都可触发检测
- 统一处理：集中的事件分发

### 8.4 工作模式过滤
**关机充电/工厂模式禁用检测**：
```c
if (power_cmdline_is_powerdown_charging_mode())
	return;
if (power_cmdline_is_factory_mode())
	return;
```

**原因**：
- 关机充电：简化系统，减少复杂逻辑
- 工厂模式：避免环境湿度干扰产线测试

### 8.5 多检测方法融合
**单一方法 vs 多方法**：
```
单一方法:
- 优点: 简单、功耗低
- 缺点: 单点故障风险

多方法融合:
- 优点: 冗余保护、可靠性高
- 缺点: 复杂度增加
```

**本框架策略**：
- 支持1-4种方法同时使能
- DTS灵活配置
- 任一方法检测到进水即触发保护

---

## 九、调试与诊断

### 9.1 日志输出
```bash
# 启用hwlog调试
echo "water_detect" > /sys/kernel/debug/dynamic_debug/control

# 关键日志示例
[water_detect] total_ops=3 type=0:usb_dp_dn ops register ok
[water_detect] total_ops=3 type=2:usb_gpio ops register ok
[water_detect] water detect disabled on factory mode
```

### 9.2 状态查询
```bash
# 内核接口 (需要添加sysfs节点)
cat /sys/class/hw_power/water_detect/status
# 输出: 0x05 (bit0和bit2为1, USB_DP_DN和USB_GPIO检测到进水)

# DMD记录
cat /sys/class/power_dsm/dsm_battery/dsm_dump
# 输出:
# DMD_NO: 926002xxx
# Content: water check is triggered : usb_dp_dn
```

### 9.3 模拟测试
```c
// 驱动层添加测试接口
static ssize_t water_detect_test_store(...)
{
	// 模拟进水事件
	power_event_notify(POWER_BNT_WD, 
		POWER_NE_WD_DETECT_BY_USB_GPIO, NULL);
}

// 用户空间触发
echo 1 > /sys/class/hw_power/water_detect/test
```

---

## 十、总结

### 核心价值
1. **统一框架**：为多种进水检测方法提供统一管理接口
2. **松耦合设计**：框架与检测实现分离，易扩展
3. **集中管理**：统一状态维护、DMD上报、Uevent通知
4. **灵活配置**：DTS配置启用/禁用检测方法
5. **冗余保护**：支持多检测方法并行，提高可靠性

### 技术亮点
- **Ops注册机制**：类似Linux驱动模型，解耦框架与实现
- **位图状态管理**：高效存储和查询多检测点状态
- **事件驱动架构**：通过power_event实现松耦合触发
- **工作模式过滤**：关机充电/工厂模式智能禁用
- **对外统一接口**：water_detect_get_intruded_status()简化查询

### 架构模式
- **中间件/框架层**：介于硬件驱动与应用逻辑之间
- **策略模式**：支持多种检测算法 (DP/DN, ID, GPIO, Audio)
- **观察者模式**：通过事件通知触发检测
- **单例模式**：全局唯一框架实例

### 适用场景
- **多芯片平台**：不同产品使用不同检测芯片
- **冗余检测**：同时使用多种方法提高可靠性
- **灵活配置**：不同产品形态选择不同检测方法
- **统一管理**：集中处理进水状态查询和上报

### 设计理念
- **分层解耦**：框架层 ↔ 驱动层 ↔ 硬件层
- **开放扩展**：新增检测方法仅需注册ops
- **集中决策**：框架统一维护进水状态
- **简化应用**：对外提供简单的bool查询接口

## 十一、与water_check的区别
|模块	|角色	|类比|
|:----:|:-----:|:------:|
|water_detect	|框架/中间件	|像Linux内核的VFS层，提供统一文件系统接口|
|water_check	|具体实现	|像ext4/ntfs文件系统，实现具体检测逻辑|

**water_detect 的价值**
✅ 统一接口：应用层只需调用一个API
✅ 状态汇总：多种检测方法OR逻辑
✅ 解耦合：应用层不依赖具体检测实现
✅ 可扩展：新增检测方法无需改应用层

**water_check 的价值**
✅ GPIO硬件检测：多位置监控
✅ 中断驱动：实时响应
✅ 去抖动：3秒延迟过滤误触发
✅ 多点联动：检测多位置同时进水
✅ 保护动作：BATFET断开等

两者关系：water_check 是 water_detect 框架下的一个具体实现，类似于"接口"与"实现类"的关系。框架负责管理，实现负责干活。