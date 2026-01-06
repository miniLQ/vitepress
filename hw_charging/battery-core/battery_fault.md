---
outline: deep
---
# 华为电池核心之battery_fault模块
## 一、模块概述
[battery_fault.c]是华为电源管理框架中的电池故障检测驱动，核心功能：

- 电池欠压保护（截止电压检测）
- 低温/休眠状态下的电压调整
- 故障事件通知与 DSM 上报
- 防误触发滤波机制

## 二、核心数据结构
```c
struct bat_fault_device {
    struct device *dev;
    struct delayed_work fault_work;         // 延迟工作队列
    struct notifier_block coul_event_nb;    // 库仑计事件通知
    struct bat_fault_config config;         // 配置参数
    struct bat_fault_data data;             // 运行时数据
    struct wakeup_source *wake_lock;        // 唤醒锁
    const struct bat_fault_ops *ops;        // 回调操作
};

// 配置参数
struct bat_fault_config {
    int vol_cutoff_normal;      // 正常模式截止电压 (默认 3150mV)
    int vol_cutoff_sleep;       // 休眠模式截止电压 (默认 3350mV)
    int vol_cutoff_low_temp;    // 低温截止电压
    int vol_cutoff_filter_cnt;  // 滤波次数 (默认 3 次)
};

// 运行数据
struct bat_fault_data {
    int vol_cutoff_sign;        // 截止标志 (1=已触发欠压)
    int vol_cutoff_used;        // 当前使用的截止电压阈值
};

// 回调接口
struct bat_fault_ops {
    void (*notify)(unsigned int event);  // 故障通知回调
};

```

## 三、关键功能模块
### 3.1 截止电压动态更新
#### 3.1.1 策略逻辑
```c
bat_fault_update_cutoff_vol(bool sleep_mode) {
    // 1. 根据系统状态选择基准电压
    if (sleep_mode)
        vol = vol_cutoff_sleep;    // 休眠: 3350mV (更保守)
    else
        vol = vol_cutoff_normal;   // 正常: 3150mV
    
    // 2. 低温保护 (温度 ≤ -5°C)
    temp = coul_interface_get_battery_temperature();
    if (temp <= BAT_FAULT_LOW_TEMP_THLD)  // -50 (表示 -5.0°C)
        vol = min(vol_cutoff_low_temp, vol);  // 使用更低的阈值
    
    // 3. 更新使用的截止电压
    di->data.vol_cutoff_used = vol;
}
```
#### 3.1.2 温度单位说明
```c
BAT_FAULT_LOW_TEMP_THLD = -50  // 表示 -5.0°C (温度 × 10)
```

应用场景：

|状态	|温度	|使用电压	|原因|
|:-----:|:-----:|:-------:|:------:|
|正常使用	|常温	|3150mV	|最大化电量利用|
|休眠状态	|常温	|3350mV	|防止长时间放置过放|
|正常使用	|低温	|低温电压	|低温内阻大，电压跌落快|

### 3.2 欠压检测和滤波
```c
bat_fault_cutoff_vol_event_handle() {
    // 1. 前置条件检查
    if (!bat_exist)
        return;  // 电池不存在，退出
    
    // 2. 多次滤波验证 (默认 3 次)
    count = di->config.vol_cutoff_filter_cnt;
    while (count-- >= 0) {
        voltage = coul_interface_get_battery_voltage();
        
        // 允许 10mV 偏差容差
        if ((voltage - BAT_FAULT_CUTOFF_VOL_OFFSET) > cutoff_vol) {
            hwlog_err("filter fail:vol=%d\n", voltage);
            return;  // 滤波失败，不是真实欠压
        }
        
        if (count > 0)
            msleep(BAT_FAULT_CUTOFF_VOL_PERIOD);  // 等待 1000ms
    }
    
    // 3. 确认欠压，设置标志
    di->data.vol_cutoff_sign = 1;
    
    // 4. 通知其他模块
    bat_fault_notify(POWER_NE_COUL_LOW_VOL);
    
    // 5. 上报 DSM 日志
    snprintf(buf, ..., 
        "[LOW VOL]cur_vol:%dmV,cut_vol=%dmV,cur_soc=%d,temp=%d,current=%d\n",
        voltage, cutoff_vol, ui_soc, temp, cur);
    power_dsm_report_dmd(POWER_DSM_BATTERY_DETECT,
        POWER_DSM_ERROR_LOW_VOL_INT, buf);
}
```
时间轴:
```
 t0         t1         t2         t3
 ↓          ↓          ↓          ↓
读取 -----> 读取 ----> 读取 ----> 确认欠压
          (1s)       (1s)
 
```
如果任意一次电压 > (cutoff + 10mV) → 退出，认为误触发

### 3.3 欠压判断入口
```c
int bat_fault_is_cutoff_vol(void)
{
    // 1. 快速路径：已标记欠压
    if (di->data.vol_cutoff_sign)
        return di->data.vol_cutoff_sign;  // 返回 1
    
    // 2. 更新截止电压阈值
    bat_fault_update_cutoff_vol(false);
    
    // 3. 实时检测
    voltage = coul_interface_get_battery_voltage();
    if (voltage < di->data.vol_cutoff_used) {
        hwlog_err("battery voltage low %d, cutoff %d\n",
            voltage, di->data.vol_cutoff_used);
        
        // 触发库仑计低压事件 (会启动滤波验证)
        power_event_bnc_notify(POWER_BNT_COUL, POWER_NE_COUL_LOW_VOL, NULL);
    }
    
    return di->data.vol_cutoff_sign;
}
```
调用链：
```c
battery_core.c (健康度检测)
    ↓
bat_fault_is_cutoff_vol()
    ↓
voltage < cutoff_vol ?
    ↓ (是)
power_event_bnc_notify(POWER_NE_COUL_LOW_VOL)
    ↓
bat_fault_coul_event_notifier_call()
    ↓
queue_delayed_work(&fault_work)
    ↓
bat_fault_work()
    ↓
bat_fault_cutoff_vol_event_handle()

```
### 3.4 欠压事件通知
```c
void bat_fault_send_under_voltage_event(void)
{
    struct power_event_notify_data n_data;
    
    // 构造 uevent 数据
    n_data.event = "BATTERY_UNDER_VOLTAGE=1";
    n_data.event_len = 23;
    
    // 发送到用户空间 (Android 系统)
    power_event_report_uevent(&n_data);
    
    hwlog_info("battery under voltage, report uevent\n");
}
```

### 3.5 库仑计事件监听
```c
static int bat_fault_coul_event_notifier_call(struct notifier_block *nb,
    unsigned long event, void *data)
{
    switch (event) {
    case POWER_NE_COUL_LOW_VOL:
        // 立即调度工作队列 (延迟 0ms)
        queue_delayed_work(system_power_efficient_wq, 
            &di->fault_work, msecs_to_jiffies(0));
        break;
    default:
        break;
    }
    return NOTIFY_OK;
}
```

### 3.6 故障回调通知
```c
static void bat_fault_notify(unsigned int event)
{
    if (!di || !di->ops || !di->ops->notify)
        return;
    
    // 调用注册的回调函数
    di->ops->notify(event);
}

// 外部模块注册回调
int bat_fault_register_ops(const struct bat_fault_ops *ops)
{
    di->ops = ops;
    return 0;
}
```

### 3.7 DTS配置解析
支持硅基/石墨基差异化配置：
```c
bat_fault_parse_dts() {
    // 根据电池阴极类型选择不同参数
    switch (bat_model_get_bat_cathode_type()) {
    case BAT_MODEL_BAT_CATHODE_TYPE_SILICON:
        // 硅基电池参数
        power_dts_read_u32("vol_cutoff_normal_si", ...);
        power_dts_read_u32("vol_cutoff_sleep_si", ...);
        power_dts_read_u32("vol_cutoff_low_temp_si", ...);
        power_dts_read_u32("vol_cutoff_filter_cnt_si", ...);
        break;
    
    case BAT_MODEL_BAT_CATHODE_TYPE_GRAPHITE:
    default:
        // 石墨基电池参数
        power_dts_read_u32("vol_cutoff_normal", ...);
        power_dts_read_u32("vol_cutoff_sleep", ...);
        power_dts_read_u32("vol_cutoff_low_temp", ...);
        power_dts_read_u32("vol_cutoff_filter_cnt", ...);
    }
}
```
DTS 示例：
```
battery_fault {
    compatible = "huawei,battery_fault";
    
    /* 石墨基电池配置 */
    vol_cutoff_normal = <3150>;        // 正常模式 3.15V
    vol_cutoff_sleep = <3350>;         // 休眠模式 3.35V
    vol_cutoff_low_temp = <3000>;      // 低温模式 3.00V
    vol_cutoff_filter_cnt = <3>;       // 滤波 3 次
    
    /* 硅基电池配置 (电压特性不同) */
    vol_cutoff_normal_si = <3000>;     // 硅基电池截止电压更低
    vol_cutoff_sleep_si = <3200>;
    vol_cutoff_low_temp_si = <2850>;
    vol_cutoff_filter_cnt_si = <5>;    // 更严格的滤波
};
```
### 3.8 电源管理
休眠/唤醒处理：
```c
// 系统准备休眠
static int bat_fault_prepare(struct device *dev)
{
    // 1. 切换到休眠模式电压阈值 (更高)
    bat_fault_update_cutoff_vol(true);
    
    // 2. 通知库仑计芯片更新中断阈值
    coul_interface_set_battery_low_voltage(
        bat_core_get_coul_type(), di->data.vol_cutoff_used);
    
    return 0;
}

// 系统唤醒完成
static void bat_fault_complete(struct device *dev)
{
    // 1. 切换回正常模式电压阈值 (更低)
    bat_fault_update_cutoff_vol(false);
    
    // 2. 通知库仑计芯片更新中断阈值
    coul_interface_set_battery_low_voltage(
        bat_core_get_coul_type(), di->data.vol_cutoff_used);
}
```
- 休眠时提高阈值：防止长时间休眠导致电池过放损坏
- 唤醒后降低阈值：最大化电量利用，延长续航

### 3.9 debug调试接口
```c
// 查看当前截止电压
bat_fault_dbg_vol_cutoff_show() {
    return scnprintf(buf, size, "vol_cutoff_used is %d\n",
        di->data.vol_cutoff_used);
}

// 动态修改截止电压 (调试用)
bat_fault_dbg_vol_cutoff_store(const char *buf, size_t size) {
    kstrtoint(buf, 0, &val);
    di->config.vol_cutoff_normal = val;
    bat_fault_update_cutoff_vol(false);
    return size;
}

```
使用方法：
```
# 查看当前截止电压
cat /sys/kernel/debug/power/bat_fault/vol_cutoff

# 设置新的截止电压 (调试)
echo 3100 > /sys/kernel/debug/power/bat_fault/vol_cutoff
```

## 四、初始化流程
```
bat_fault_probe()
├── 1. 分配设备结构体 (kzalloc)
├── 2. 解析 DTS 配置
│   └── 根据电池类型 (硅基/石墨基) 选择参数
├── 3. 注册 Debug 接口
├── 4. 初始化截止电压 (休眠模式)
│   └── bat_fault_update_cutoff_vol(true)
├── 5. 创建延迟工作队列
│   └── INIT_DELAYED_WORK(&fault_work, bat_fault_work)
├── 6. 注册库仑计事件监听
│   └── power_event_bnc_register(POWER_BNT_COUL, &coul_event_nb)
├── 7. 创建唤醒锁
│   └── power_wakeup_source_register()
└── 8. 设置全局指针 g_bat_fault_dev
```

## 五、关键宏定义
```c
BAT_FAULT_NORMAL_CUTOFF_VOL   3150    // 正常截止电压 3.15V
BAT_FAULT_SLEEP_CUTOFF_VOL    3350    // 休眠截止电压 3.35V
BAT_FAULT_CUTOFF_VOL_OFFSET   10      // 滤波容差 10mV
BAT_FAULT_CUTOFF_VOL_FILTERS  3       // 滤波次数
BAT_FAULT_CUTOFF_VOL_PERIOD   1000    // 滤波间隔 1000ms
BAT_FAULT_LOW_TEMP_THLD       -50     // 低温阈值 -5.0°C
BAT_FAULT_DSM_BUF_SIZE        256     // DSM 缓冲区大小
```

## 六、典型应用场景
### 6.1 正常使用突然欠压
1. 用户使用手机，电量显示 3%
2. 电压读数 3140mV < 3150mV (截止电压)
3. bat_fault_is_cutoff_vol() 检测到欠压
4. 触发 POWER_NE_COUL_LOW_VOL 事件
5. 启动延迟工作队列，进行 3 次滤波验证
   - t=0s:   voltage = 3140mV ✓
   - t=1s:   voltage = 3135mV ✓
   - t=2s:   voltage = 3130mV ✓
6. 确认真实欠压
   - vol_cutoff_sign = 1
   - 通知 battery_core 更新健康状态
   - 上报 DSM: "[LOW VOL]cur_vol:3130mV,cut_vol=3150mV,cur_soc=3,..."
7. battery_core 设置健康度 = POWER_SUPPLY_HEALTH_UNDERVOLTAGE
8. 发送 uevent 到 Android 层
9. Android 触发关机流程

### 6.2 充电时误触发（负载突降）
1. 用户插入充电器瞬间
2. 充电电流突增，电池内阻压降导致电压瞬降
3. 瞬时读数 3140mV < 3150mV
4. 触发第 1 次滤波检测: voltage = 3140mV ✓
5. 等待 1s，充电稳定后
6. 第 2 次滤波检测: voltage = 3600mV ✗ (超过阈值)
7. 滤波失败，认为误触发，退出
8. vol_cutoff_sign 保持 0，不触发关机

### 6.3 低温环境欠压
1. 环境温度 -10°C
2. 电池温度读数 -100 (表示 -10.0°C) < -50
3. bat_fault_update_cutoff_vol() 选择低温截止电压
   - vol_cutoff_used = min(vol_cutoff_low_temp, vol_cutoff_normal)
   - 假设 vol_cutoff_low_temp = 3000mV
4. 使用更低的阈值 3000mV 进行判断
5. 避免低温下内阻大导致的误关机

### 6.4 休眠期间长时间放置
1. 手机进入休眠 (suspend)
2. bat_fault_prepare() 被调用
3. 切换到休眠截止电压 3350mV (更高)
4. 通知库仑计芯片更新中断阈值
5. 库仑计硬件监控电压
6. 如果电压 < 3350mV，触发硬件中断唤醒系统
7. 系统执行关机流程，防止过放

## 七、模块依赖
```
battery_fault.c
├── coul_interface (库仑计接口)
│   ├── get_battery_voltage()
│   ├── get_battery_temperature()
│   ├── get_battery_avg_current()
│   ├── is_battery_exist()
│   └── set_battery_low_voltage()
├── battery_core (电池核心)
│   └── bat_core_get_coul_type()
├── battery_ui_capacity (UI 电量)
│   └── bat_ui_capacity()
├── battery_model (电池型号)
│   └── bat_model_get_bat_cathode_type()
├── power_event (事件通知)
│   ├── power_event_bnc_notify()
│   └── power_event_report_uevent()
└── power_dsm (DSM 上报)
    └── power_dsm_report_dmd()
```

## 八、电压阈值设计原理
为什么需要不同的截止电压？
|场景	|截止电压	|原因|
|:----:|:------:|:------:|
|正常使用	|3150mV	|最大化电量利用，避免过早关机|
|休眠状态	|3350mV	|防止长时间静置导致过放损坏电池|
|低温环境	|3000mV	|低温内阻大，电压跌落快，降低阈值避免误关机|
滤波容差设计：

```
实际判断条件: voltage < (cutoff_vol + 10mV)

原因:
1. ADC 读数有 ±5mV 误差
2. 电池内阻导致瞬时压降
3. 10mV 容差可过滤大部分毛刺
```

## 九、调试建议
日志关键词
```
dmesg | grep battery_fault
dmesg | grep "LOW VOL"
dmesg | grep "cutoff"
```
关键日志示例：
```
battery_fault: v_cut=3150, v_sleep=3350, v_low_temp=3000, temp=250, vol=3150
battery_fault: filter fail:vol=3200,count=2,v_cut=3150
battery_fault: cutoff:vol=3130,v_cut=3150,cur_soc=3
battery_fault: battery under voltage, report uevent
```

Debug 节点：
```sh
# 查看当前截止电压
cat /sys/kernel/debug/power/bat_fault/vol_cutoff

# 临时修改截止电压 (测试用)
echo 3100 > /sys/kernel/debug/power/bat_fault/vol_cutoff
```

模拟欠压测试：
```sh
# 1. 降低截止电压阈值
echo 3800 > /sys/kernel/debug/power/bat_fault/vol_cutoff

# 2. 观察日志，应该立即触发欠压检测
dmesg | tail -20

```

## 总结
`battery_fault`是电池安全的最后一道防线，通过多级滤波和动态阈值调整，准确识别真实欠压，防止电池过放损坏，同时避免误触发影响用户体验。