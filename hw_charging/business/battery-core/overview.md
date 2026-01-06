---
outline: deep
---

# 华为充电管理之电池核心
battery_core.c 是华为电源管理框架的电池核心驱动，负责：

- 电池状态监控与数据采集
- Power Supply 框架接口实现
- 电池健康度管理
- UI 电量显示控制

## 一、核心数据结构
```c
/*
 * 电量等级描述结构
 * 用于根据 UI 电量(capacity) 映射成离散的电量等级 level
 * 常用于策略判断（如不同 SOC 档位采取不同策略）
 */
struct bat_core_capacity_level {
	int min_cap;   /* 该等级适用的最小电量百分比（包含） */
	int max_cap;   /* 该等级适用的最大电量百分比（包含） */
	int level;     /* 电量等级值（由 DTS/策略定义的抽象等级） */
};


/*
 * battery_core 监控周期参数
 * 根据当前电量区间，动态调整 battery_core monitor work 的刷新周期
 */
struct bat_core_monitor_para {
	int min_cap;   /* 该参数生效的最小电量百分比 */
	int max_cap;   /* 该参数生效的最大电量百分比 */
	int interval;  /* 对应的 monitor work 调度周期（单位：ms） */
};


/*
 * battery_core 配置结构
 * 主要来自 device tree（DTS），用于描述电池/库仑计/温度相关参数
 */
struct bat_core_config {
	int voltage_now_scale;   /* 电池瞬时电压缩放系数（用于 raw 数据转 mV） */
	int voltage_max_scale;   /* 最大充电电压缩放系数（用于 vterm 计算） */
	int charge_fcc_scale;    /* FCC（满充容量）缩放系数 */
	int charge_rm_scale;     /* RM（剩余容量）缩放系数 */

	int coul_type;           /* 库仑计类型：主库仑计 / 辅助库仑计（COUL_TYPE_xxx） */
	int temp_type;           /* 温度来源类型（直读库仑计 / 混合温度源等） */

	int work_para_cols;      /* 实际生效的监控参数行数（work_para 数组有效项数） */
	int ntc_compensation_is; /* 是否启用 NTC 温度补偿（0：关闭，1：开启） */

	/* 根据电量区间配置的 monitor work 周期参数表 */
	struct bat_core_monitor_para work_para[BAT_CORE_WORK_PARA_ROW];

	/* NTC 温度补偿参数表（按电流/温区分档） */
	struct compensation_para temp_comp_para[BAT_CORE_NTC_PARA_LEVEL];
};

/*
 * battery_core 运行时数据缓存
 * 由 monitor work 周期性刷新，并通过 power_supply / ops 对外提供
 */
struct bat_core_data {
	int exist;             /* 电池是否在位（1：存在，0：不存在） */
	int charge_status;     /* 当前充电状态（POWER_SUPPLY_STATUS_xxx） */
	int health;            /* 电池健康状态（POWER_SUPPLY_HEALTH_xxx） */

	int ui_capacity;       /* UI 显示的电量百分比（0~100） */
	int capacity_level;    /* 当前电量等级（由 capacity_level 表映射） */

	int temp_now;          /* 当前电池温度（单位：0.1°C 或 m°C，视实现而定） */
	int cycle_count;       /* 电池循环次数 */
	int fcc;               /* 电池满充容量 FCC（已按 scale 处理） */

	int voltage_max_now;   /* 当前允许的最大充电电压（动态可调） */
	int capacity_rm;       /* 剩余容量 RM（已按 scale 处理） */
};

/*
 * battery_core 设备实例
 * 作为整个 battery_core 驱动的核心上下文
 */
struct bat_core_device {
	struct device *dev;                 /* 对应的 platform device */

	struct power_supply *main_psy;      /* 主电池 power_supply 设备（battery_gauge） */
	struct power_supply *aux_psy;       /* 辅助电池 power_supply 设备（battery_gauge_aux） */

	int work_interval;                  /* 当前 monitor work 的调度周期（ms） */
	struct delayed_work monitor_work;   /* 周期性刷新电池数据的 work */

	struct wakeup_source *wakelock;     /* 防止 monitor 执行过程中系统休眠的 wakelock */

	struct mutex data_lock;             /* 保护 bat_core_data 的互斥锁 */

	struct notifier_block event_nb;     /* 充电/电源事件通知回调 */

	struct bat_core_config config;      /* DTS 解析得到的配置参数 */
	struct bat_core_data data;          /* 当前电池状态的数据缓存 */
};


```
驱动核心对象是 struct bat_core_device *di（全局 `g_bat_core_dev` 也会保存一份）。

## 二、关键功能模块
### 2.1 Power supply属性接口
```c
static enum power_supply_property bat_core_props[] = {
    POWER_SUPPLY_PROP_PRESENT,      // 电池存在
    POWER_SUPPLY_PROP_ONLINE,       // 在线状态
    POWER_SUPPLY_PROP_TEMP,         // 温度
    POWER_SUPPLY_PROP_CYCLE_COUNT,  // 循环次数
    POWER_SUPPLY_PROP_VOLTAGE_NOW,  // 电压
    POWER_SUPPLY_PROP_CURRENT_NOW,  // 电流
    POWER_SUPPLY_PROP_CAPACITY,     // 电量
    POWER_SUPPLY_PROP_CHARGE_FULL,  // 满充容量
};
```
属性获取函数：
`bat_core_get_prop()`: 根据 coul_type (主/辅电池) 从库仑计读取数据
支持双电池系统 (COUL_TYPE_MAIN / COUL_TYPE_AUX)

### 2.2电池状态管理
核心 getter 函数：

|函数	|功能	|数据来源
|:-----:|:-----|:-------|
|bat_core_get_status()	|充电状态	|di->data.charge_status|
|bat_core_get_health()	|健康状态	|di->data.health|
|bat_core_get_temp()	|电池温度	|bat_core_temp()|
|bat_core_get_voltage_now()	|实时电压	|coul_interface|
|bat_core_get_ui_capacity()	|UI 电量	|bat_ui_capacity()|

电量等级映射
```
// UI 电量 → 电量等级转换
0-5%    → CRITICAL (危险)
5-15%   → LOW (低)
15-95%  → NORMAL (正常)
95-100% → HIGH (高)
100%    → FULL (满)
```

### 2.3定期监控机制

```c

  static void bat_core_work(struct work_struct *work)
  {
      // 获取唤醒锁，防止系统休眠
      __pm_wakeup_event(di->wakelock, jiffies_to_msecs(HZ));

      // 核心数据更新
      bat_core_update_data(di);

      // 动态调整监控间隔
      bat_core_update_work_interval(di);

      // 重新调度下一次执行
      queue_delayed_work(system_freezable_power_efficient_wq, &di->monitor_work,
          msecs_to_jiffies(di->work_interval));
  }
```
**动态监控策略：**
bat_core_update_work_interval(di) 让监控刷新频率随电量变化：
- 如果 health unknown：直接用 `BAT_CORE_WORK_INTERVAL_ABNORMAL`
- 如果 DTS 没配 work_interval_para：用默认 `BAT_CORE_WORK_INTERVAL_NORMAL`
- 否则读取 work_interval_para（min_cap、max_cap、interval），匹配当前 ui_capacity，选择对应 interval

```
// DTS 配置示例
work_interval_para = <
    0  20  5000    // 0-20%: 5秒
    20 80  10000   // 20-80%: 10秒
    80 100 5000    // 80-100%: 5秒
>;
```
这个动态监控测率
- 根据电量区间动态调整监控频率
- 低电量时缩短间隔 (快速响应)
- 正常电量可延长间隔 (省电)
> 低电/异常状态更频繁刷新，高电/稳定状态降低刷新频率省电。

### 2.4 温度补偿算法
#### 2.4.1 温度读取入口
`bat_core_temp(di)` 是统一入口：
```c
static int bat_core_temp(struct bat_core_device *di)
{
    if (temp_type == BAT_CORE_TEMP_TYPE_MIXED) {
        // 混合温度 (多温度源融合)
        bat_temp_get_temperature(BAT_TEMP_MIXED, &raw_temp);
    } else {
        // 库仑计温度 + NTC 补偿
        raw_temp = coul_interface_get_battery_temperature();
        raw_temp = bat_core_ntc_compensation_temp(di, raw_temp, bat_curr);
    }
}
```

- 如果 temp_type == BAT_CORE_TEMP_TYPE_MIXED，用 bat_temp_get_temperature(BAT_TEMP_MIXED, &raw_temp)（可能是多源融合后的温度）
- 否则：
    - raw_temp = coul_interface_get_battery_temperature(...)
    - bat_curr = coul_interface_get_battery_current(...)
    - 再走 bat_core_ntc_compensation_temp() 做 NTC 补偿

#### 2.4.2 NTC 补偿参数来自 DTS
`bat_core_parse_temp_para()` 从 device tree 读取：
- temp_type
- ntc_compensation_is（是否启用补偿）
- ntc_temp_compensation_para（补偿表：参考电流 refer + 补偿值 comp_value 等）

补偿逻辑里会根据当前电流（abs(cur_temp)）查表/计算，最终输出补偿后的温度，并打印：
> temp_compensation=... temp_no_comp=... ichg=...

- 防止大电流充电时温升影响温度读数
- 补偿参数通过 DTS 配置

### 2.5 健康度的判定
```c
static void bat_core_update_health(struct bat_core_device *di)
{
    if (!di->data.exist) {
        health = POWER_SUPPLY_HEALTH_UNKNOWN;
    } else if (temp_now == BAT_CORE_TEMP_UNKNOWN) {
        health = POWER_SUPPLY_HEALTH_UNKNOWN;
    } else if (bat_fault_is_cutoff_vol()) {
        health = POWER_SUPPLY_HEALTH_UNDERVOLTAGE;  // 欠压
        bat_fault_send_under_voltage_event();
    } else if (temp_now < BAT_CORE_COLD_TEMP) {
        health = POWER_SUPPLY_HEALTH_COLD;          // 低温
    } else if (temp_now > BAT_CORE_OVERHEAT_TEMP) {
        health = POWER_SUPPLY_HEALTH_OVERHEAT;      // 过热
    } else {
        health = POWER_SUPPLY_HEALTH_GOOD;          // 正常
    }
}
```
`bat_core_update_health(di)` 负责把 di->data.health 更新为标准 power_supply health：
判定顺序大致是：
- 电池不在位：HEALTH_UNKNOWN
- 温度未知：HEALTH_UNKNOWN
- 如果 bat_fault_is_cutoff_vol()：HEALTH_UNDERVOLTAGE，并触发 bat_fault_send_under_voltage_event()
- 温度过低 < BAT_CORE_COLD_TEMP：HEALTH_COLD
- 温度过高 > BAT_CORE_OVERHEAT_TEMP：HEALTH_OVERHEAT
- 否则：HEALTH_GOOD

并且只在变化时打印 “health change from x to y”。

### 2.6 充电状态更新
```c
static void bat_core_update_charge_status(struct bat_core_device *di, int status)
{
    // 特殊处理：充电中 + 电量满 → 充满状态
    if ((status == POWER_SUPPLY_STATUS_CHARGING) &&
        (di->data.ui_capacity == BAT_CORE_CAPACITY_FULL)) {
        cur_status = POWER_SUPPLY_STATUS_FULL;
    }
    
    // 状态变化时同步通知 Android 层
    if (di->data.charge_status != cur_status) {
        di->data.charge_status = cur_status;
        power_supply_sync_changed("Battery");  // 大写 B
        power_supply_sync_changed("battery");  // 小写 b
    }
}
```

### 2.7 事件驱动的状态更新
驱动会注册一个事件通知：
`power_event_bnc_register(POWER_BNT_CHARGING, &di->event_nb);`
回调是 `bat_core_event_notifier_call()`，把事件映射为充电状态：
- POWER_NE_CHARGING_START → POWER_SUPPLY_STATUS_CHARGING
- POWER_NE_CHARGING_STOP → DISCHARGING
- POWER_NE_CHARGING_SUSPEND → NOT_CHARGING

```c
static int bat_core_event_notifier_call(struct notifier_block *nb,
    unsigned long event, void *data)
{
    switch (event) {
    case POWER_NE_CHARGING_START:
        status = POWER_SUPPLY_STATUS_CHARGING;      // 开始充电
        break;
    case POWER_NE_CHARGING_STOP:
        status = POWER_SUPPLY_STATUS_DISCHARGING;   // 停止充电
        break;
    case POWER_NE_CHARGING_SUSPEND:
        status = POWER_SUPPLY_STATUS_NOT_CHARGING;  // 充电暂停
        break;
    }
    bat_core_update_charge_status(di, status);
}
```

然后进 `bat_core_update_charge_status(di, status)`：
- 如果正在充电且 ui_capacity==100，强制变成 FULL
- 状态发生变化时会调用：
    - power_supply_sync_changed("Battery");
    - power_supply_sync_changed("battery");

这一步非常关键：**它让系统/上层（包括 framework/界面）立刻感知状态变更，而不是等下一个 work 周期**。

### 2.8 双库仑计支持
DTS 里会读 coul_type：
- COUL_TYPE_MAIN
- COUL_TYPE_AUX

或者两者都注册

bat_core_reg_guage_psy() 会按配置注册：
- battery_gauge
- battery_gauge_aux

并且 bat_core_get_prop() 会通过 psy == di->aux_psy 来区分 type（main/aux），对同一套属性返回不同来源的数据。

### 2.9 电池故障通知
驱动注册了 `bat_fault_register_ops(&g_bat_core_fault_ops)`，注册到故障管理模块

当 `bat_core_fault_notify(event)` 收到：POWER_NE_COUL_LOW_VOL
会 mod_delayed_work(..., 0) 立刻调度一次 monitor_work，把低压状态尽快刷新给系统。

```c
	bat_fault_register_ops(&g_bat_core_fault_ops);

static const struct bat_fault_ops g_bat_core_fault_ops = {
	.notify = bat_core_fault_notify,
};

static void bat_core_fault_notify(unsigned int event)
{
	struct bat_core_device *di = g_bat_core_dev;

	if (!di)
		return;

	switch (event) {
    // 如果是POWER_NE_COUL_LOW_VOL，也就是低压状态立即刷新work
	case POWER_NE_COUL_LOW_VOL:
		mod_delayed_work(system_freezable_power_efficient_wq, &di->monitor_work,
			msecs_to_jiffies(0));
		break;
	default:
		break;
	}
	hwlog_info("fault event notify=%d\n", event);
}
```
其实就是通知链，当其他模块call chain时会调用到这里
比如在`bat_fault_cutoff_vol_event_handle`中
```c
static void bat_fault_cutoff_vol_event_handle(struct bat_fault_device *di)
{
    //...
	bat_fault_notify(POWER_NE_COUL_LOW_VOL);
}
```

## 三、DTS配置解析
```c
bat_core_parse_dts() {
    // 1. 库仑计类型
    coul_type = COUL_TYPE_MAIN | COUL_TYPE_AUX | COUL_TYPE_BOTH
    
    // 2. 温度类型
    temp_type = BAT_CORE_TEMP_TYPE_RAW_COMP | BAT_CORE_TEMP_TYPE_MIXED
    
    // 3. NTC 温度补偿参数
    ntc_compensation_is = 1
    ntc_temp_compensation_para = <
        1000 -2   // 充电电流 1000mA, 补偿 -2°C
        2000 -5   // 充电电流 2000mA, 补偿 -5°C
    >
    
    // 4. 电压/容量缩放系数
    voltage_now_scale = 1000000  // μV
    voltage_max_scale = 1000000
    charge_fcc_scale = 1000      // μAh
}
```

## 四、初始化流程
```
bat_core_probe()
├── 1. 分配设备结构体
├── 2. 解析 DTS 配置
├── 3. 初始化数据 (默认值)
├── 4. 注册 Power Supply 操作集
├── 5. 注册充电事件通知
├── 6. 注册 battery_gauge PSY
├── 7. 创建唤醒锁
├── 8. 启动监控任务
└── 9. 注册故障回调
```

## 五、模块依赖
```
battery_core.c
├── coul_interface (库仑计接口)
├── bat_ui_capacity (UI 电量算法)
├── bat_model (电池模型)
├── bat_temp (温度管理)
├── bat_fault (故障检测)
└── power_supply (Linux 电源框架)
```

## 六、调试接口
1. 查看日志关键字: battery_core
2. 监控节点:
	- /sys/class/power_supply/battery_gauge/
	- /sys/class/power_supply/battery_gauge_aux/
3. 关键函数打点:
	- bat_core_update_charge_status()
	- bat_core_update_health()
	- bat_core_work()

## 七、流程图

![](./images/UML_battery_core.svg)
<script setup>
import umlUrl from './images/UML_battery_core.svg?url'
</script>
高清大图：<a :href="umlUrl" target="_blank" rel="noreferrer">流程图高清</a>