---
outline: deep
---

# 温度控制 (temp_control) 模块分析

## 一、模块概述

### 1.1 功能定位
`temp_control` 是华为 MATE X5 充电系统的**温度监控与保护模块**，主要功能是：
- **USB接口温度监测**：实时监控 USB 充电接口的温度变化
- **分级限流保护**：根据温度区间动态调整最大输出电流
- **滞后控制算法**：采用滞后曲线防止频繁切换温度等级
- **DMD异常上报**：温度超限时自动上报故障信息
- **充电安全保护**：高温场景下限制充电电流，防止设备过热损坏

### 1.2 设计目标
- **温度保护**：防止 USB 接口因高温烧毁
- **用户体验**：通过滞后算法避免充电电流频繁抖动
- **故障诊断**：温度异常时自动收集环境信息并上报
- **多级控制**：支持最多 8 级温度区间的精细化管理

---

## 二、核心架构

### 2.1 模块结构图
```
┌─────────────────────────────────────────────────────┐
│            temp_control 温度控制模块                    │
├─────────────────────────────────────────────────────┤
│  初始化层                                             │
│  ├─ probe: DTS参数解析                                │
│  ├─ power_event监听注册                               │
│  └─ delayed_work创建                                  │
├─────────────────────────────────────────────────────┤
│  控制层                                               │
│  ├─ notifier_call: 充电事件响应                       │
│  │   ├─ CHARGING_START → start监测                   │
│  │   └─ CHARGING_STOP  → stop监测                    │
│  └─ monitor_work: 周期性温度检查 (30s)                │
├─────────────────────────────────────────────────────┤
│  算法层                                               │
│  ├─ check_usb_port_temp: USB温度检测                  │
│  │   ├─ power_temp_get_average_value: 获取温度       │
│  │   ├─ power_get_hysteresis_index: 滞后计算         │
│  │   └─ 返回当前档位最大电流限制                       │
│  └─ dmd_report: 温度异常上报                          │
│      └─ 携带电池/充电器/电压/SOC等环境信息              │
├─────────────────────────────────────────────────────┤
│  接口层                                               │
│  ├─ power_temp: 温度采集                              │
│  ├─ power_dsm: 故障上报                               │
│  └─ power_supply_app: 电池信息                        │
└─────────────────────────────────────────────────────┘
```

### 2.2 工作流程
```
充电启动事件
    ↓
启动monitor_work (30s周期)
    ↓
┌──────────────────────────────────────┐
│ 循环监测流程                           │
│  1. 获取USB接口平均温度                │
│  2. 滞后算法计算档位index              │
│  3. 判断是否需要DMD上报                │
│  4. 返回当前档位最大限流iout_max       │
│  5. 等待30s后下次检测                  │
└──────────────────────────────────────┘
    ↓
充电停止事件 → 取消监测 + 重置index
```

---

## 三、关键数据结构

### 3.1 温度控制参数
```c
struct temp_control_para_info {
	int iout_max;        // 最大输出电流 (mA)
	int dmd_no;          // DMD故障码 (0表示不上报)
	int dmd_max_cnt;     // 最大上报次数
	int dmd_count;       // 已上报次数
};
```

### 3.2 设备管理结构
```c
struct temp_control_dev {
	struct notifier_block nb;                               // 充电事件通知
	struct delayed_work monitor_work;                       // 周期监测任务
	struct hysteresis_para usb_port_hys[8];                // USB温度滞后曲线
	struct temp_control_para_info usb_port_para[8];        // USB温度参数
	int usb_port_para_size;                                 // 配置档位数
	int usb_port_para_index;                                // 当前档位索引
};
```

### 3.3 滞后曲线参数 (来自power_algorithm)
```c
struct hysteresis_para {
	int refer_lth;       // 下限温度阈值 (°C)
	int refer_hth;       // 上限温度阈值 (°C)
	int hys_value;       // 滞后回差值 (°C)
};
```

---

## 四、核心算法实现

### 4.1 滞后控制算法
**目的**：防止温度在阈值附近波动时频繁切换档位

**原理示意**：
```
温度 (°C)
  ↑
60┤     ┌──────────────── 档位2 ───────────────┐
  │     │  hth=60°C                             │
55┤     ↓回差55°C (hys=5°C)                     ↑升温55°C (lth=55°C)
  │     ┌──────────────── 档位1 ───────────────┐
50┤     │  hth=50°C                             │
  │     ↓回差45°C (hys=5°C)                     ↑升温50°C (lth=50°C)
45┤     ┌──────────────── 档位0 ───────────────┘
  └─────┴─────────────────────────────────────→ 时间
```

**算法逻辑**：
```c
// 调用公共滞后计算函数
int power_get_hysteresis_index(int cur_index, struct common_hys_data *data)
{
	// data->refer: 当前温度
	// data->para[i].refer_lth: 第i档下限
	// data->para[i].refer_hth: 第i档上限
	// data->para[i].hys_value: 第i档回差
	
	// 向上查找: 当前温度 ≥ refer_lth
	// 向下查找: 当前温度 < (refer_lth - hys_value)
}
```

### 4.2 USB接口温度检测
```c
static int temp_control_check_usb_port_temp(struct temp_control_dev *l_dev)
{
	// 1. 获取USB接口平均温度 (mC单位)
	usb_temp = power_temp_get_average_value(POWER_TEMP_USB_PORT);
	
	// 2. 转换为°C并设置滞后计算参数
	hys.refer = usb_temp / 1000;  // mC → °C
	hys.para_size = l_dev->usb_port_para_size;
	hys.para = l_dev->usb_port_hys;
	
	// 3. 计算新的档位索引
	l_dev->usb_port_para_index = power_get_hysteresis_index(
		l_dev->usb_port_para_index, &hys);
	
	// 4. 判断是否需要DMD上报
	if (l_dev->usb_port_para[index].dmd_no > 0) {
		// 收集电池温度、充电器类型、品牌、电压、SOC等信息
		// 调用 temp_control_dmd_report 上报
	}
	
	// 5. 返回当前档位最大电流
	return l_dev->usb_port_para[index].iout_max;
}
```

### 4.3 DMD上报逻辑
```c
static void temp_control_dmd_report(struct temp_control_para_info *info,
	const char *buf)
{
	// 检查是否配置DMD号
	if (info->dmd_no <= 0)
		return;
	
	// 限制上报次数 (防止频繁上报)
	if (info->dmd_count++ >= info->dmd_max_cnt) {
		hwlog_info("dmd report over %d time\n", info->dmd_max_cnt);
		return;
	}
	
	// 调用DSM接口上报故障
	power_dsm_report_dmd(POWER_DSM_BATTERY, info->dmd_no, buf);
}
```

**上报信息格式**：
```
t_usb 58 is exceed 55, t_bat=35 chg_type=3 brand=ATL volt=4200 soc=85
解释：USB温度58°C超过阈值55°C，电池35°C，充电器类型3，品牌ATL，电压4200mV，电量85%
```

---

## 五、DTS配置示例

### 5.1 配置格式
```dts
huawei_temp_control: huawei,temp_control {
	compatible = "huawei,temp_control";
	status = "ok";
	
	/* USB接口温度控制参数
	 * 格式: <lth hth back iout_max dmd_no dmd_max_cnt>
	 * lth: 下限温度 (°C)
	 * hth: 上限温度 (°C)
	 * back: 回差温度 (°C)
	 * iout_max: 最大电流 (mA)
	 * dmd_no: DMD故障码 (0=不上报)
	 * dmd_max_cnt: 最大上报次数
	 */
	usb_port_para = <
		// 档位0: <45°C, 不限流, 不上报
		0   45  0   3000  0        0
		
		// 档位1: 45-50°C, 限流2000mA, 不上报
		45  50  3   2000  0        0
		
		// 档位2: 50-55°C, 限流1500mA, 上报DMD 926001xxx (最多5次)
		50  55  3   1500  926001001  5
		
		// 档位3: 55-60°C, 限流1000mA, 上报DMD 926001xxx (最多5次)
		55  60  3   1000  926001002  5
		
		// 档位4: 60-65°C, 限流500mA, 上报DMD 926001xxx (最多5次)
		60  65  3   500   926001003  5
		
		// 档位5: ≥65°C, 停止充电, 上报DMD 926001xxx (最多5次)
		65  999 3   0     926001004  5
	>;
};
```

### 5.2 参数说明
| 参数 | 含义 | 典型值 |
|------|------|--------|
| lth | 档位下限温度 | 0/45/50/55/60/65°C |
| hth | 档位上限温度 | 45/50/55/60/65/999°C |
| back | 滞后回差 | 3-5°C |
| iout_max | 最大输出电流 | 0/500/1000/1500/2000/3000mA |
| dmd_no | DMD故障码 | 0 或 926001xxx |
| dmd_max_cnt | 最多上报次数 | 3-10次 |

---

## 六、充电事件管理

### 6.1 事件监听注册
```c
l_dev->nb.notifier_call = temp_control_notifier_call;
power_event_bnc_register(POWER_BNT_CHARGING, &l_dev->nb);
```

### 6.2 事件处理逻辑
```c
static int temp_control_notifier_call(struct notifier_block *nb,
	unsigned long event, void *data)
{
	switch (event) {
	case POWER_NE_CHARGING_STOP:
		// 停止监测 + 重置档位索引
		cancel_delayed_work(&l_dev->monitor_work);
		l_dev->usb_port_para_index = 0;
		break;
		
	case POWER_NE_CHARGING_START:
		// 启动周期性监测 (延迟30s)
		cancel_delayed_work(&l_dev->monitor_work);
		schedule_delayed_work(&l_dev->monitor_work, 
			msecs_to_jiffies(30000));
		break;
	}
	return NOTIFY_OK;
}
```

### 6.3 监测任务调度
```c
static void temp_control_monitor_work(struct work_struct *work)
{
	// 1. 检测USB接口温度
	if (l_dev->usb_port_para_size != 0)
		temp_control_check_usb_port_temp(l_dev);
	
	// 2. 重新调度下次检测 (30s后)
	schedule_delayed_work(&l_dev->monitor_work, 
		msecs_to_jiffies(30000));
}
```

---

## 七、典型应用场景

### 7.1 快充高温保护
**场景**：使用超级快充时，USB接口温度快速上升

**处理流程**：
```
1. 初始状态: 温度40°C, 档位0, 限流3000mA (正常充电)
2. 温度升至48°C: 仍在档位0 (未达到lth=45°C)
3. 温度升至52°C: 切换到档位2 (超过lth=50°C)
   → 限流1500mA, 上报DMD 926001001
4. 温度继续升至57°C: 切换到档位3 (超过lth=55°C)
   → 限流1000mA, 上报DMD 926001002
5. 温度回落至53°C: 仍在档位3 (未低于55-3=52°C回差线)
6. 温度继续回落至51°C: 切换回档位2 (低于52°C回差线)
   → 限流1500mA
7. 温度回落至46°C: 切换回档位1 (低于50-3=47°C回差线)
   → 限流2000mA
8. 温度回落至42°C: 切换回档位0 (低于45-3=42°C回差线)
   → 限流恢复3000mA
```

### 7.2 环境高温限流
**场景**：夏季户外使用，环境温度35°C

**策略**：
- 温度基线更高，更容易触发限流档位
- 通过DMD上报收集高温使用数据
- 分析是否需要调整温度阈值或冷却设计

### 7.3 异常高温告警
**场景**：USB接口温度异常升高至65°C以上

**响应**：
- 立即停止充电 (iout_max=0)
- 上报严重DMD故障 (dmd_no=926001004)
- 记录详细环境信息供售后分析

---

## 八、调试与诊断

### 8.1 日志输出
```bash
# 启用hwlog调试信息
echo "temp_control" > /sys/kernel/debug/dynamic_debug/control

# 关键日志示例
[temp_control] suspend begin
[temp_control] resume begin
[temp_control] dmd report over 5 time  # 达到最大上报次数
```

### 8.2 DMD故障分析
**查看DMD记录**：
```bash
cat /sys/class/power_dsm/dsm_battery/dsm_dump
```

**典型DMD内容**：
```
DMD_NO: 926001002
Content: t_usb 58 is exceed 55, t_bat=35 chg_type=3 brand=ATL volt=4200 soc=85
```

**分析要点**：
- `t_usb`: USB接口实际温度
- `exceed`: 触发温度阈值
- `t_bat`: 电池温度 (判断是否整机过热)
- `chg_type`: 充电器类型 (判断是否快充导致)
- `volt/soc`: 充电状态 (判断是否接近满电)

### 8.3 温度监测节点
```bash
# 查看USB接口温度
cat /sys/class/power_temp/usb_port/temp_now  # 单位: mC

# 查看电池温度
cat /sys/class/power_supply/battery/temp  # 单位: 0.1°C
```

---

## 九、与其他模块协作

### 9.1 依赖接口
| 模块 | 接口 | 用途 |
|------|------|------|
| power_temp | power_temp_get_average_value | 获取USB接口平均温度 |
| power_dsm | power_dsm_report_dmd | 上报DMD故障 |
| power_supply | power_supply_app_get_bat_* | 获取电池温度/电压/SOC/品牌 |
| charge | charge_get_charger_type | 获取充电器类型 |
| power_algorithm | power_get_hysteresis_index | 滞后曲线计算 |

### 9.2 数据流向
```
power_temp (温度采集)
    ↓
temp_control (档位计算)
    ↓
返回 iout_max → 充电管理模块 (限流执行)
    ↓
power_dsm (异常上报)
```

---

## 十、关键技术要点

### 10.1 滞后控制优势
- **防抖动**：温度在阈值附近波动时不会频繁切换档位
- **用户体验**：充电电流稳定，避免频繁限流导致的充电速度波动
- **延长寿命**：减少充电控制芯片的频繁开关

### 10.2 周期性监测
- **监测周期**：30秒 (DELAY_TIME_FOR_SLOW_WORK)
- **设计考虑**：温度变化较慢，无需高频监测，节省功耗
- **扩展性**：预留10秒快速监测周期 (未使用)

### 10.3 DMD上报限制
```c
if (info->dmd_count++ >= info->dmd_max_cnt) {
	hwlog_info("dmd report over %d time\n", info->dmd_max_cnt);
	return;
}
```
**目的**：防止高温持续时频繁上报造成日志爆炸

### 10.4 电源管理支持
```c
static int temp_control_suspend(struct platform_device *pdev, pm_message_t state)
{
	cancel_delayed_work_sync(&l_dev->monitor_work);
	return 0;
}
```
**目的**：系统休眠时停止监测，节省功耗

---

## 十一、总结

### 核心价值
1. **安全保护**：通过温度分级限流，防止USB接口烧毁
2. **智能控制**：滞后算法避免频繁切换，提升用户体验
3. **故障诊断**：自动收集温度异常环境信息，辅助售后分析
4. **灵活配置**：支持最多8级温度档位，适应不同产品需求

### 技术亮点
- **滞后曲线算法**：工业级温度控制策略
- **DMD自动上报**：携带完整环境信息的故障诊断
- **周期性监测**：低功耗长周期设计
- **事件驱动**：充电启停自动控制监测任务

### 适用场景
- **快充设备**：大功率充电时的温度保护
- **高温环境**：夏季户外或车载充电
- **异常诊断**：USB接口老化或异物导致的温度异常