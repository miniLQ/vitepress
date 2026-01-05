# 华为充电管理之电池核心

代码位于：drivers/hwpower/cc_battery/battery_core.c

battery_core.c 本质是一个 Battery Core 中枢驱动：

- 底层数据来源主要来自库仑计接口：coul_interface_get_* / coul_interface_is_battery_exist()
- 电池参数来源来自电池模型：bat_model_get_vbat_max()、bat_model_get_brand() 等

对外输出有两套：
- Linux power_supply：注册 battery_gauge / battery_gauge_aux 两个 psy
- 华为自研 power_supply_ops：注册 raw_bat、assist_bat 两套 ops（给华为电源框架其它模块调用）

## 核心数据结构
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

## 定期刷新机制

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

> 这能做到：低电/异常状态更频繁刷新，高电/稳定状态降低刷新频率省电。

## 温度的判定
### 温度读取入口
`bat_core_temp(di)` 是统一入口：
- 如果 temp_type == BAT_CORE_TEMP_TYPE_MIXED，用 bat_temp_get_temperature(BAT_TEMP_MIXED, &raw_temp)（可能是多源融合后的温度）
- 否则：
    - raw_temp = coul_interface_get_battery_temperature(...)
    - bat_curr = coul_interface_get_battery_current(...)
    - 再走 bat_core_ntc_compensation_temp() 做 NTC 补偿

### NTC 补偿参数来自 DTS
`bat_core_parse_temp_para()` 从 device tree 读取：
- temp_type
- ntc_compensation_is（是否启用补偿）
- ntc_temp_compensation_para（补偿表：参考电流 refer + 补偿值 comp_value 等）

补偿逻辑里会根据当前电流（abs(cur_temp)）查表/计算，最终输出补偿后的温度，并打印：
> temp_compensation=... temp_no_comp=... ichg=...

## 健康度的判定
`bat_core_update_health(di)` 负责把 di->data.health 更新为标准 power_supply health：
判定顺序大致是：
- 电池不在位：HEALTH_UNKNOWN
- 温度未知：HEALTH_UNKNOWN
- 如果 bat_fault_is_cutoff_vol()：HEALTH_UNDERVOLTAGE，并触发 bat_fault_send_under_voltage_event()
- 温度过低 < BAT_CORE_COLD_TEMP：HEALTH_COLD
- 温度过高 > BAT_CORE_OVERHEAT_TEMP：HEALTH_OVERHEAT
- 否则：HEALTH_GOOD

并且只在变化时打印 “health change from x to y”。

## 事件驱动的状态更新
驱动会注册一个事件通知：
`power_event_bnc_register(POWER_BNT_CHARGING, &di->event_nb);`
回调是 `bat_core_event_notifier_call()`，把事件映射为充电状态：
- POWER_NE_CHARGING_START → POWER_SUPPLY_STATUS_CHARGING
- POWER_NE_CHARGING_STOP → DISCHARGING
- POWER_NE_CHARGING_SUSPEND → NOT_CHARGING

然后进 `bat_core_update_charge_status(di, status)`：
- 如果正在充电且 ui_capacity==100，强制变成 FULL
- 状态发生变化时会调用：
    - power_supply_sync_changed("Battery");
    - power_supply_sync_changed("battery");

这一步非常关键：**它让系统/上层（包括 framework/界面）立刻感知状态变更，而不是等下一个 work 周期**。

## 双库仑计支持
DTS 里会读 coul_type：
- COUL_TYPE_MAIN
- COUL_TYPE_AUX

或者两者都注册

bat_core_reg_guage_psy() 会按配置注册：
- battery_gauge
- battery_gauge_aux

并且 bat_core_get_prop() 会通过 psy == di->aux_psy 来区分 type（main/aux），对同一套属性返回不同来源的数据。

## 异常状态
驱动注册了 `bat_fault_register_ops(&g_bat_core_fault_ops)`;

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

## 流程图
![](./images/UML_battery_core.svg)
高清大图：[流程图高清](./images/UML_battery_core.svg)