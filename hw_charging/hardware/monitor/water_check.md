---
outline: deep
---


# 进水检测 (water_check) 模块分析

## 一、模块概述

### 1.1 功能定位
`water_check` 是华为 MATE X5 的 **多位置进水检测模块**，主要功能是：
- **多点位监测**：支持SIM卡槽、耳机孔、按键等多个位置进水检测
- **GPIO中断检测**：通过GPIO中断实时响应进水事件
- **去抖动处理**：3秒延迟消除误触发
- **DMD故障上报**：进水事件自动上报故障码
- **多位置联动**：检测多个位置同时进水的严重情况
- **保护动作**：进水时可触发BATFET断开等保护措施

### 1.2 检测原理
**进水检测传感器**：通过GPIO检测水分导致的电阻/电容变化
- 正常状态：GPIO = 1 (高电平，干燥)
- 进水状态：GPIO = 0 (低电平，水分导电)

### 1.3 设计目标
- **安全保护**：防止进水导致短路、腐蚀、烧毁
- **多位置覆盖**：SIM卡槽、耳机孔、按键等易进水部位
- **快速响应**：中断驱动实时检测
- **误报抑制**：3秒去抖 + 状态记忆防止重复上报

---

## 二、核心架构

### 2.1 模块结构图
```
┌────────────────────────────────────────────────────────┐
│           water_check 进水检测模块                         │
├────────────────────────────────────────────────────────┤
│  初始化层                                                │
│  ├─ probe: DTS解析 + GPIO配置                           │
│  ├─ water_check_parse_dts: 解析检测位置参数              │
│  ├─ water_check_config_gpio: 配置GPIO + 中断             │
│  └─ 延迟8s启动首次检测                                    │
├────────────────────────────────────────────────────────┤
│  中断处理层                                              │
│  ├─ water_check_irq_handler: GPIO中断响应                │
│  │   ├─ disable_irq: 禁用中断                           │
│  │   ├─ wakelock: 持有唤醒锁                            │
│  │   └─ schedule 3s延迟工作                             │
│  └─ water_check_irq_work: 延迟工作队列                   │
│      ├─ 读取所有GPIO状态                                 │
│      ├─ 单点进水检测 (SINGLE_POSITION)                   │
│      ├─ 多点进水检测 (MULTIPLE_INTRUDED)                 │
│      ├─ DMD上报                                          │
│      ├─ 执行保护动作 (BATFET断开)                        │
│      └─ enable_irq: 恢复中断 + 释放wakelock              │
├────────────────────────────────────────────────────────┤
│  检测算法层                                              │
│  ├─ 单点检测逻辑                                         │
│  │   ├─ GPIO=0 → 进水                                   │
│  │   ├─ 状态变化 || 首次检测 → DMD上报                   │
│  │   └─ last_check_status记录上次状态                   │
│  └─ 多点联动检测                                         │
│      ├─ 统计进水位置数量                                 │
│      ├─ 匹配预设多点类型 (如2点/3点同时进水)              │
│      └─ 触发更高级别DMD + 保护动作                        │
├────────────────────────────────────────────────────────┤
│  保护执行层                                              │
│  ├─ BATFET_DISABLED_ACTION                              │
│  │   └─ charge_set_batfet_disable(true)                │
│  │      → 断开电池连接，防止短路                         │
│  └─ (其他保护动作可扩展)                                 │
├────────────────────────────────────────────────────────┤
│  对外接口层                                              │
│  └─ usb_gpio_water_detect_ops                           │
│      └─ is_water_intruded: 查询USB是否进水               │
│         → 供充电模块查询，决定是否允许充电                │
└────────────────────────────────────────────────────────┘
```

### 2.2 检测流程
```
系统启动
    ↓
延迟8s启动首次检测 (irq_work)
    ↓
读取所有GPIO初始状态 → 记录last_check_status
    ↓
使能所有GPIO中断
    ↓
┌──────────────────────────────────────────┐
│ 正常运行状态                               │
│ GPIO=1 (干燥), 中断使能                    │
└──────────────────────────────────────────┘
    ↓ 进水事件 (GPIO 1→0)
    ↓
GPIO中断触发 (FALLING_EDGE)
    ↓
water_check_irq_handler
    ├─ 禁用所有GPIO中断 (防止重复触发)
    ├─ 持有wakelock (防止系统休眠)
    └─ 延迟3s调度irq_work (去抖动)
    ↓
┌──────────────────────────────────────────┐
│ 3秒后irq_work执行                         │
│  1. 遍历所有检测位置                       │
│  2. 读取GPIO状态                           │
│  3. GPIO=0 → 确认进水                     │
│     ├─ 单点进水处理                        │
│     │  ├─ 对比上次状态                     │
│     │  ├─ 状态变化 → DMD上报               │
│     │  └─ 执行保护动作                     │
│     └─ 记录multiple_handle标志             │
│  4. 统计进水位置数量                       │
│  5. 多点进水检测                           │
│     └─ 匹配type=2/3/... → DMD + 保护      │
│  6. 更新last_check_status                │
│  7. 恢复中断 + 释放wakelock                │
└──────────────────────────────────────────┘
    ↓ 水分蒸发 (GPIO 0→1)
    ↓
GPIO中断触发 (RISING_EDGE)
    ↓
3秒后irq_work确认干燥
    ├─ GPIO=1 → 恢复正常
    ├─ dsm_report_status恢复为NEED_REPORT
    └─ 下次进水可再次上报
```

---

## 三、关键数据结构

### 3.1 检测位置参数
```c
struct water_check_para {
	int type;                    // 位置类型 (1=单点, 2/3/...=多点)
	char gpio_name[16];          // GPIO名称 (如"sim", "usb", "earhole")
	int irq_no;                  // 中断号
	int dmd_no_offset;           // DMD故障码偏移 (99=不上报)
	int gpio_no;                 // GPIO编号
	u8 multiple_handle;          // 是否参与多点检测 (0/1)
	u8 prompt;                   // 是否提示用户 (0/1)
	u8 action;                   // 保护动作 (0=无, 1=BATFET断开)
};
```

### 3.2 设备管理结构
```c
struct water_check_info {
	struct device *dev;
	struct delayed_work irq_work;              // 延迟工作队列 (3s去抖)
	struct water_check_data data;              // 检测位置参数数组
	struct wakeup_source *wakelock;            // 唤醒锁
	
	// 状态记录
	char dsm_buff[60];                         // DMD上报缓冲
	u8 last_check_status[16];                  // 上次GPIO状态
	u8 dsm_report_status[16];                  // DMD上报状态
	
	// 配置参数
	u32 gpio_type;                             // GPIO类型 (0=普通, 1=线程化)
	u32 irq_trigger_type;                      // 中断触发类型 (0=双边沿, 1=低电平)
	u32 pinctrl_enable;                        // 是否使能Pinctrl
};
```

### 3.3 状态定义
```c
// 进水状态
#define WATER_IN       1   // 检测到进水
#define WATER_NULL     0   // 未检测到进水

// DMD上报状态
#define DSM_NEED_REPORT  1  // 需要上报
#define DSM_REPORTED     0  // 已上报 (避免重复)

// 位置类型
#define SINGLE_POSITION  1  // 单点位置
// type=2/3/... 表示多点联动类型
```

---

## 四、核心功能实现

### 4.1 单点进水检测
```c
// 遍历所有检测位置
for (i = 0; i < info->data.total_type; i++) {
	// 仅处理单点位置
	if (info->data.para[i].type != SINGLE_POSITION)
		continue;
	
	// 读取GPIO状态
	gpio_val = gpio_get_value_cansleep(info->data.para[i].gpio_no);
	
	// GPIO=0 → 检测到进水
	if (!gpio_val) {
		// 标记参与多点检测
		if (info->data.para[i].multiple_handle) {
			water_intruded_num++;
			snprintf(dsm_buff + strlen(dsm_buff), SIZE,
				"%s ", info->data.para[i].gpio_name);
		}
		
		// 判断是否需要DMD上报
		// 条件1: 状态发生变化 (干燥→进水)
		// 条件2: 首次检测 (dsm_report_status=NEED_REPORT)
		if ((gpio_val ^ info->last_check_status[i]) ||
		    info->dsm_report_status[i]) {
			water_check_dmd_report(info, i);     // DMD上报
			water_check_process_action(info, i); // 执行保护动作
		}
	}
	
	// GPIO=1 (干燥) → 恢复DMD上报状态
	if (gpio_val)
		info->dsm_report_status[i] = DSM_NEED_REPORT;
	
	// 记录本次状态
	info->last_check_status[i] = gpio_val;
}
```

**状态转换逻辑**：
```
初始状态: gpio=1, last_status=1, dsm_status=NEED_REPORT
    ↓ 进水
gpio=0, last_status=1
→ 状态变化 (0 ^ 1 = 1)
→ DMD上报 + 保护动作
→ dsm_status=REPORTED
→ last_status=0
    ↓ 持续进水
gpio=0, last_status=0
→ 无状态变化 (0 ^ 0 = 0)
→ 不重复上报
    ↓ 水分蒸发
gpio=1, last_status=0
→ 状态变化 (1 ^ 0 = 1)
→ 但gpio=1不执行DMD上报
→ dsm_status恢复为NEED_REPORT
→ last_status=1
    ↓ 再次进水
gpio=0, last_status=1
→ 可再次上报DMD
```

### 4.2 多点联动检测
**应用场景**：多个位置同时进水 → 严重进水事件

```c
// 统计进水位置数量
int water_intruded_num = 0;
for (i = 0; i < total_type; i++) {
	if (gpio=0 && multiple_handle)
		water_intruded_num++;
}

// 多点进水检测
if (water_intruded_num > SINGLE_POSITION) {  // >1个位置
	for (i = 0; i < total_type; i++) {
		// 匹配预设多点类型
		if (water_intruded_num == info->data.para[i].type) {
			water_check_dmd_report(info, i);     // 多点DMD上报
			water_check_process_action(info, i); // 严重保护动作
		}
	}
}
```

**多点类型配置示例**：
```
单点位置 (type=1):
- para[0]: SIM卡槽 (单独进水处理)
- para[1]: 耳机孔 (单独进水处理)
- para[2]: USB接口 (单独进水处理)

多点类型 (type=2):
- para[3]: type=2 → 任意2个位置同时进水时触发

多点类型 (type=3):
- para[4]: type=3 → 任意3个位置同时进水时触发
```

**检测示例**：
```
场景1: 仅SIM卡槽进水
→ water_intruded_num=1
→ 触发para[0]的DMD上报 (type=1)

场景2: SIM卡槽 + 耳机孔同时进水
→ water_intruded_num=2
→ 触发para[0]和para[1]的单点DMD (type=1)
→ 触发para[3]的多点DMD (type=2)
→ dsm_buff: "water check is triggered in: sim earhole"

场景3: SIM + 耳机 + USB全部进水
→ water_intruded_num=3
→ 触发3个单点DMD (type=1)
→ 触发para[3]的2点DMD (type=2)
→ 触发para[4]的3点DMD (type=3)
→ 执行严重保护动作 (如BATFET断开)
```

### 4.3 保护动作执行
```c
static void water_check_process_action(struct water_check_info *info, int i)
{
	switch (info->data.para[i].action) {
	case BATFET_DISABLED_ACTION:  // action=1
		hwlog_info("charge set batfet to disable\n");
		msleep(50);  // 延迟50ms
		charge_set_batfet_disable(true);  // 断开电池MOSFET
		break;
	default:
		break;  // 其他保护动作可扩展
	}
}
```

**BATFET断开作用**：
```
正常状态: BATFET闭合 → 电池连接系统
    ↓
严重进水检测
    ↓
BATFET断开
    ├─ 电池与主板电气隔离
    ├─ 防止进水导致短路
    ├─ 保护电池和主板
    └─ 系统可能关机 (仅外部供电)
```

### 4.4 中断去抖动
```c
static irqreturn_t water_check_irq_handler(int irq, void *p)
{
	struct water_check_info *info = p;
	
	// 1. 禁用所有GPIO中断 (防止重复触发)
	water_check_disable_irq(info);
	
	// 2. 延迟3秒调度工作队列 (去抖动)
	schedule_delayed_work(&info->irq_work, 
		msecs_to_jiffies(DEBOUNCE_TIME));  // 3000ms
	
	return IRQ_HANDLED;
}

static void water_check_disable_irq(struct water_check_info *info)
{
	// 持有唤醒锁 (防止系统休眠)
	power_wakeup_lock(info->wakelock, true);
	
	// 禁用所有单点位置的中断
	for (i = 0; i < info->data.total_type; i++) {
		if (info->data.para[i].type == SINGLE_POSITION)
			disable_irq_nosync(info->data.para[i].irq_no);
	}
}

static void water_check_enable_irq(struct water_check_info *info)
{
	// 恢复所有单点位置的中断
	for (i = 0; i < info->data.total_type; i++) {
		if (info->data.para[i].type == SINGLE_POSITION)
			enable_irq(info->data.para[i].irq_no);
	}
	
	// 释放唤醒锁
	power_wakeup_unlock(info->wakelock, true);
}
```

**去抖动时序**：
```
T=0ms:     GPIO中断触发 (可能是干扰/误触发)
           → irq_handler立即禁用中断
           → 调度3s后执行irq_work
           
T=3000ms:  irq_work执行
           → 读取GPIO状态
           → 如果仍是0 → 确认进水
           → 如果已是1 → 误触发，忽略
           → 恢复中断使能
```

### 4.5 USB进水查询接口
**对外提供接口**：供充电模块查询USB是否进水

```c
static int usb_gpio_is_water_intruded(void *dev_data)
{
	struct water_check_info *info = g_info;
	int i, gpio_value;
	
	// 遍历所有检测位置
	for (i = 0; i < info->data.total_type; i++) {
		// 查找USB相关GPIO
		if (strncmp(info->data.para[i].gpio_name, 
		    "usb", strlen("usb")))
			continue;
		
		// 读取GPIO状态
		gpio_value = gpio_get_value(info->data.para[i].gpio_no);
		if (!gpio_value) {  // GPIO=0 → 进水
			hwlog_info("water is detected in usb\n");
			return WATER_IN;  // 返回进水状态
		}
	}
	
	return WATER_NULL;  // 无进水
}

// 注册到water_detect框架
static struct water_detect_ops usb_gpio_water_detect_ops = {
	.type_name = "usb_gpio",
	.is_water_intruded = usb_gpio_is_water_intruded,
};
```

**充电模块调用**：
```c
// 充电前检查USB是否进水
if (water_detect_is_water_intruded("usb_gpio")) {
	// USB进水 → 禁止充电
	disable_charging();
	show_water_warning();
}
```

---

## 五、DTS配置示例

### 5.1 完整配置
```dts
huawei_water_check: huawei,water_check {
	compatible = "huawei,water_check";
	status = "ok";
	
	/* GPIO类型
	 * 0: 普通GPIO中断 (devm_request_irq)
	 * 1: 线程化GPIO中断 (devm_request_threaded_irq)
	 */
	gpio_type = <1>;
	
	/* 中断触发类型
	 * 0: 双边沿触发 (RISING + FALLING)
	 * 1: 低电平触发 (TRIGGER_LOW)
	 */
	irq_trigger_type = <0>;
	
	/* Pinctrl使能 */
	pinctrl_enable = <1>;
	pinctrl-names = "default", "idle";
	pinctrl-0 = <&water_check_default>;
	pinctrl-1 = <&water_check_idle>;
	
	/* GPIO定义 */
	gpio_sim = <&gpio10 2 0>;      // SIM卡槽检测GPIO
	gpio_earhole = <&gpio10 3 0>;  // 耳机孔检测GPIO
	gpio_usb = <&gpio10 4 0>;      // USB接口检测GPIO
	
	/* 检测位置参数
	 * 格式: <type gpio_name irq_no multiple_handle dmd_no_offset prompt action>
	 */
	water_check_para = <
		// SIM卡槽: 单点检测
		1 "sim" 0 1 0 1 0
		// 解释:
		// type=1: 单点位置
		// gpio_name="sim": GPIO名称
		// irq_no=0: 中断号 (由代码分配)
		// multiple_handle=1: 参与多点检测
		// dmd_no_offset=0: DMD故障码偏移0
		// prompt=1: 提示用户
		// action=0: 无保护动作
		
		// 耳机孔: 单点检测
		1 "earhole" 0 1 1 1 0
		
		// USB接口: 单点检测
		1 "usb" 0 1 2 1 0
		
		// 2点同时进水: 多点类型
		2 "multiple_2" 0 0 10 1 0
		// type=2: 2个位置同时进水时触发
		// gpio_name="multiple_2": 仅用于标识
		// multiple_handle=0: 不参与统计 (本身是统计结果)
		// dmd_no_offset=10: DMD故障码偏移10
		
		// 3点全部进水: 多点类型 (严重进水)
		3 "multiple_3" 0 0 20 1 1
		// type=3: 3个位置全部进水
		// action=1: BATFET断开保护
	>;
};
```

### 5.2 参数详解
| 字段 | 含义 | 典型值 | 说明 |
|------|------|--------|------|
| type | 位置类型 | 1/2/3/... | 1=单点, ≥2=多点联动 |
| gpio_name | GPIO名称 | sim/usb/earhole | 用于日志和DTS引用 |
| irq_no | 中断号 | 0 | 由gpio_to_irq()分配 |
| multiple_handle | 参与多点检测 | 0/1 | 1=参与统计 |
| dmd_no_offset | DMD偏移 | 0-99 | 加到基础码上, 99=不上报 |
| prompt | 提示用户 | 0/1 | 1=显示进水提示 |
| action | 保护动作 | 0/1 | 0=无, 1=BATFET断开 |

### 5.3 DMD故障码计算
```c
// DMD故障码 = 基础码 + 偏移
dmd_no = POWER_DSM_ERROR_NO_WATER_CHECK_BASE + dmd_no_offset;

示例:
基础码 = 926002000
SIM卡槽: offset=0 → DMD=926002000
耳机孔: offset=1 → DMD=926002001
USB接口: offset=2 → DMD=926002002
2点进水: offset=10 → DMD=926002010
3点进水: offset=20 → DMD=926002020
```

---

## 六、典型应用场景

### 6.1 雨天SIM卡槽进水
```
T=0s:     用户雨天更换SIM卡，SIM卡槽进水
          → GPIO_SIM: 1 → 0
          → 触发GPIO中断
          
T=0.001s: irq_handler执行
          → 禁用所有GPIO中断
          → 持有wakelock
          → 调度3s后执行irq_work
          
T=3s:     irq_work执行
          → 读取GPIO_SIM=0 (仍是进水状态)
          → 确认进水, 非误触发
          → last_status=1, gpio=0 → 状态变化
          → DMD上报: "water check is triggered in: sim"
          → DMD_NO = 926002000
          → dsm_report_status=REPORTED
          → last_status=0
          → 恢复中断 + 释放wakelock
          
T=3.1s:   用户空间接收DMD
          → 显示进水提示: "检测到SIM卡槽进水，请擦干后使用"
          
T=10min:  水分自然蒸发
          → GPIO_SIM: 0 → 1
          → 触发GPIO中断 (RISING)
          → 3s后irq_work确认干燥
          → dsm_report_status恢复为NEED_REPORT
          → 下次进水可再次提示
```

### 6.2 掉入水中 - 严重进水
```
T=0s:     手机掉入水中
          → GPIO_SIM: 1→0
          → GPIO_EARHOLE: 1→0
          → GPIO_USB: 1→0
          → 3个GPIO同时触发中断
          
T=0.001s: irq_handler多次调用
          → 禁用所有中断 (只禁用一次)
          → 调度3s后irq_work
          
T=3s:     irq_work执行
          → 单点检测:
             GPIO_SIM=0 → DMD上报 (offset=0)
             GPIO_EARHOLE=0 → DMD上报 (offset=1)
             GPIO_USB=0 → DMD上报 (offset=2)
          → water_intruded_num=3
          → 多点检测:
             匹配type=2 → DMD上报 (offset=10)
             匹配type=3 → DMD上报 (offset=20)
          → action=1 (BATFET断开)
             charge_set_batfet_disable(true)
             → 电池断开连接
             → 系统关机 (保护主板)
             
T=3.1s:   系统执行关机流程
          → 保存日志
          → 上报DMD故障
          → 关机
```

### 6.3 充电前进水检测
```
用户插入充电器
    ↓
充电驱动检查进水状态
    ↓
water_detect_is_water_intruded("usb_gpio")
    ↓
usb_gpio_is_water_intruded()
    ├─ 查找gpio_name="usb"
    ├─ 读取GPIO_USB
    └─ 返回 WATER_IN / WATER_NULL
    ↓
if (WATER_IN) {
    // USB进水 → 禁止充电
    disable_charging();
    show_notification("USB接口进水，请擦干后充电");
} else {
    // 正常充电
    start_charging();
}
```

### 6.4 误触发场景 - 去抖动
```
T=0ms:     环境电磁干扰
           → GPIO瞬间0
           → 触发中断
           
T=0.1ms:   irq_handler
           → 禁用中断
           → 调度3s后irq_work
           
T=10ms:    干扰消失
           → GPIO恢复1
           
T=3000ms:  irq_work执行
           → 读取GPIO=1 (干燥状态)
           → gpio=1 → 不执行DMD上报
           → 恢复中断
           → 成功过滤误触发
```

---

## 七、与其他模块协作

### 7.1 依赖接口
| 模块 | 接口 | 用途 |
|------|------|------|
| power_dsm | power_dsm_report_dmd | 上报DMD故障 |
| power_wakeup | power_wakeup_lock/unlock | 持有/释放唤醒锁 |
| charger | charge_set_batfet_disable | 控制BATFET开关 |
| water_detect | water_detect_ops_register | 注册进水检测接口 |
| GPIO子系统 | gpio_request/gpio_to_irq | GPIO资源管理 |

### 7.2 对外提供接口
```c
// 注册到water_detect框架
water_detect_ops_register(&usb_gpio_water_detect_ops);

// 其他模块调用
bool is_water = water_detect_is_water_intruded("usb_gpio");

// 使用场景:
// 1. 充电驱动: 检查USB进水状态, 决定是否允许充电
// 2. 音频驱动: 检查耳机孔进水, 保护耳机芯片
// 3. 系统服务: 定期查询进水状态, 更新UI提示
```

### 7.3 DMD故障流转
```
water_check_irq_work (检测到进水)
    ↓
water_check_dmd_report
    ↓
power_dsm_report_dmd(POWER_DSM_BATTERY, dmd_no, buff)
    ↓
DSM子系统
    ├─ 记录到/sys/class/power_dsm/dsm_battery/dsm_dump
    ├─ 上报到云端 (OTA服务器)
    └─ 通知用户空间 (uevent)
    ↓
SystemUI / BatteryService
    └─ 显示进水提示对话框
```

---

## 八、关键技术要点

### 8.1 去抖动机制
**问题**：GPIO容易受电磁干扰产生毛刺
```
干扰信号: ___┐┌┐┌┐___
真实进水: _______┐┐┐┐┐___
```

**解决方案**：3秒延迟 + 状态确认
```c
T=0ms:   中断触发 → 禁用中断 → 调度3s延迟
T=3000ms: 重新读取GPIO → 确认真实状态
```

### 8.2 状态记忆防重复上报
```c
// 上次状态记录
u8 last_check_status[16];   // 0=进水, 1=干燥

// DMD上报状态
u8 dsm_report_status[16];   // NEED_REPORT / REPORTED

// 判断逻辑
if ((gpio_val ^ last_check_status[i]) ||  // 状态变化
    dsm_report_status[i]) {                // 或首次检测
	water_check_dmd_report(info, i);
}
```

**优势**：
- 进水持续时不重复上报
- 干燥后再进水可再次上报
- 首次检测必定上报

### 8.3 多点联动检测
**分级保护策略**：
```
1点进水: 轻微 → 提示用户
2点进水: 中等 → 提示 + 限制功能
3点进水: 严重 → BATFET断开 + 关机
```

**实现方式**：
```c
// 统计进水位置数量
int water_intruded_num = 0;

// 匹配预设多点类型
for (i = 0; i < total_type; i++) {
	if (water_intruded_num == para[i].type) {
		// 执行对应级别的保护
	}
}
```

### 8.4 Wakelock保护
```c
// 中断触发时持有wakelock
water_check_disable_irq:
	power_wakeup_lock(wakelock, true);

// 检测完成后释放
water_check_enable_irq:
	power_wakeup_unlock(wakelock, true);
```

**目的**：防止检测过程中系统休眠
```
中断触发 → 持有wakelock
    ↓
3秒延迟 (系统保持唤醒)
    ↓
irq_work完成检测
    ↓
释放wakelock → 允许休眠
```

### 8.5 中断类型选择
```c
// 配置1: 双边沿触发 (irq_trigger_type=0)
irqflags = IRQF_TRIGGER_RISING | IRQF_TRIGGER_FALLING;
// 优势: 进水(FALLING)和干燥(RISING)都能检测

// 配置2: 低电平触发 (irq_trigger_type=1)
irqflags = IRQF_TRIGGER_LOW;
// 优势: 持续进水状态下保持中断 (某些平台需要)
```

### 8.6 线程化中断
```c
// gpio_type=0: 普通中断
devm_request_irq(dev, irq, handler, flags, name, data);

// gpio_type=1: 线程化中断 (推荐)
devm_request_threaded_irq(dev, irq, NULL, handler, flags, name, data);
```

**线程化中断优势**：
- 中断处理可睡眠 (调用msleep)
- 减少硬中断占用时间
- 提高系统实时性

---

## 九、调试与诊断

### 9.1 日志输出
```bash
# 启用hwlog调试
echo "water_check" > /sys/kernel/debug/dynamic_debug/control

# 关键日志示例
[water_check] irq_handler irq_no:215           # 中断触发
[water_check] detect_work start                # 开始检测
[water_check] water is detected in usb         # USB检测到进水
[water_check] single_position dsm_buff:water check is triggered in: usb
[water_check] multiple_intruded dsm_buff:water check is triggered in: sim usb
[water_check] charge set batfet to disable     # 执行BATFET断开
[water_check] detect_work end                  # 检测结束
```

### 9.2 DMD故障查询
```bash
# 查看DMD记录
cat /sys/class/power_dsm/dsm_battery/dsm_dump

# 输出示例:
DMD_NO: 926002000
Content: water check is triggered in: sim
Timestamp: 2026-01-07 10:30:15

DMD_NO: 926002020
Content: water check is triggered in: sim earhole usb
Timestamp: 2026-01-07 10:32:45
```

### 9.3 手动触发测试
```bash
# 查看GPIO状态
cat /sys/kernel/debug/gpio
# 输出:
# gpio-162 (water_sim) in  1  # 正常干燥
# gpio-163 (water_usb) in  0  # 检测到进水

# 模拟进水 (需要root权限)
echo 0 > /sys/class/gpio/gpio162/value  # 模拟SIM卡槽进水
# 系统日志会打印检测流程
```

---

## 十、总结

### 核心价值
1. **多位置保护**：覆盖SIM卡槽、耳机孔、USB等易进水部位
2. **快速响应**：GPIO中断实时检测，3秒确认
3. **分级保护**：单点提示 → 多点限制 → 全部进水断电
4. **误报抑制**：3秒去抖 + 状态记忆防止重复上报
5. **安全保护**：严重进水时BATFET断开，保护电池和主板

### 技术亮点
- **去抖动算法**：3秒延迟确认，过滤干扰和误触发
- **状态机管理**：last_check_status记录历史，防止重复上报
- **多点联动**：统计进水位置数量，分级保护
- **Wakelock保护**：检测期间防止系统休眠
- **线程化中断**：支持中断处理中睡眠操作
- **对外接口**：water_detect框架供其他模块查询

### 适用场景
- **雨天使用**：SIM卡槽、耳机孔进水
- **意外落水**：多个位置同时进水
- **充电保护**：USB接口进水禁止充电
- **音频保护**：耳机孔进水保护耳机芯片
- **电池保护**：严重进水时BATFET断开

### 设计理念
- **预防为主**：实时监测，及时保护
- **分级响应**：轻微进水提示，严重进水断电
- **用户友好**：干燥后自动恢复，可再次提示
- **硬件保护**：BATFET断开物理隔离电池
- **扩展性强**：支持多种GPIO类型和中断模式