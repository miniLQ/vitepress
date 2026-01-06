---
outline: deep
---
# 华为电池核心之battery_1s2p模块

## 一、模块概述

battery_1s2p 是华为电源管理子系统中的**双电池并联管理驱动**，专门用于处理 **1S2P（1串2并）电池配置**场景。该模块实现了双电池的智能融合算法，通过加权计算提供统一的 SOC、电压、电流等参数，对外呈现为单一电池系统。

**核心功能：**
- 双电池独立监控（主电池 BAT_MAIN + 辅助电池 BAT_AUX）
- 基于电压阈值的动态加权 SOC 融合算法
- 容量比例配置与管理
- 双电池差异检测与故障报告（DSM/DMD）
- 自适应监控间隔调整
- 统一 coul_interface_ops 接口实现

---

## 二、主要数据结构

### 2.1 每电池信息结构体 `battery_info`

```c
struct battery_info {
    int soc;                          // 电池SOC（%）
    int last_soc;                     // 上次记录的SOC
    int volt;                         // 电池电压（mV）
    int cur;                          // 电池电流（mA）
    unsigned int cap_ratio;           // 容量占比（50% = CAP_RATIO_MAX / 2）
    unsigned int weight_chg[WEIGHT_FACTOR_COUNT];    // 充电权重因子数组（3个）
    unsigned int weight_dischg[WEIGHT_FACTOR_COUNT]; // 放电权重因子数组（3个）
    unsigned int volt_low;            // 低电压阈值（mV）
};
```

**说明：**
- `cap_ratio`: 该电池在总容量中的占比（默认 50%，即两电池容量相同）
- `weight_chg/weight_dischg`: 三段式权重因子，对应不同电压区间：
  - `[0]`: 电压 < volt_low 时的权重
  - `[1]`: volt_low ≤ 电压 < VOLT_HIGH_THRESHOLD 时的权重
  - `[2]`: 电压 ≥ VOLT_HIGH_THRESHOLD 时的权重

### 2.2 主设备结构体 `bat_1s2p_device`

```c
struct bat_1s2p_device {
    struct device *dev;
    struct power_wakeup_source *wakelock;
    struct delayed_work monitor;
    struct mutex lock;
    struct battery_info bat_info[BAT_TOTAL];  // 双电池信息数组
    unsigned int interval;                    // 监控周期（ms）
    unsigned int cap_diff_thr;                // 容量差异阈值（%）
    int vol_type;                             // 电压查询类型
    int cycle_type;                           // 循环次数查询类型
    int last_cap_type;                        // 最后容量查询类型
    int temp_type;                            // 温度查询类型
};
```

---

## 三、核心算法

### 1. 加权 SOC 融合算法 `bat_1s2p_get_mix_soc()`

**算法流程：**

```c
混合SOC = (主电池SOC × 主电池权重 + 辅助电池SOC × 辅助电池权重) 
          / (主电池权重 + 辅助电池权重)
```

**权重选择逻辑：**

| 电压区间 | 权重数组索引 | 说明 |
|---------|------------|------|
| 电压 < volt_low | `weight_xxx[0]` | 低电压区，电池特性差异大 |
| volt_low ≤ 电压 < VOLT_HIGH_THRESHOLD (4200mV) | `weight_xxx[1]` | 中等电压区 |
| 电压 ≥ VOLT_HIGH_THRESHOLD | `weight_xxx[2]` | 高电压区，接近满电 |

**充放电状态判断：**
- 充电状态：优先使用 `weight_chg` 数组
- 放电状态：优先使用 `weight_dischg` 数组

**示例权重配置（DTS）：**
```
weight_factor_chg_0 = <20 50 80>;    // 主电池充电权重（低/中/高）
weight_factor_dischg_0 = <30 50 70>; // 主电池放电权重
weight_factor_chg_1 = <80 50 20>;    // 辅助电池充电权重
weight_factor_dischg_1 = <70 50 30>; // 辅助电池放电权重
```

### 2. 监控间隔自适应算法 `bat_1s2p_select_work_interval()`

| SOC 范围 | 监控间隔 |
|---------|---------|
| SOC < 10% | 10 秒 |
| 10% ≤ SOC < 90% | 60 秒 |
| SOC ≥ 90% | 10 秒 |

**设计理念：** 在电量极低/极高时提高监控频率，确保准确捕捉关键状态变化。

### 3. 故障检测算法 `bat_1s2p_detect_fault_send_dmd()`

**检测项：**
1. **电池缺失检测：** 任一电池 SOC ≤ 0% 时判定为缺失
2. **容量差异检测：** `|主电池SOC - 辅助电池SOC| > cap_diff_thr` 时触发告警

**DMD 上报：**
```c
power_dsm_report_dmd(POWER_DSM_BATTERY, 
    ERROR_BATT_TEMP_CCAL_DIFF_OVH, 
    "battery_1s2p: battery%d missing");  // 电池缺失
    
power_dsm_report_dmd(POWER_DSM_BATTERY,
    ERROR_BATT_TEMP_CCAL_DIFF_OVH,
    "capacity_diff=%d%%");  // 容量差异
```

---

## 四、coul_interface_ops 接口实现

### 核心接口映射表

| 接口函数 | 实现策略 | 说明 |
|---------|---------|------|
| `read_battery_soc` | 加权融合 | 调用 `bat_1s2p_get_mix_soc()` |
| `read_battery_vol` | 按 vol_type 选择 | 主电池/辅助电池/最大/最小/平均 |
| `read_battery_current` | 求和 | 主电池电流 + 辅助电池电流 |
| `read_battery_fcc` | 按容量比加权 | `主电池FCC × 主电池占比 + 辅助电池FCC × 辅助电池占比` |
| `read_battery_cycle` | 按 cycle_type 选择 | 主电池/辅助电池/最大/最小/平均 |
| `get_battery_temperature` | 调用 battery_temp 接口 | `bat_temp_get_temperature(temp_type)` |

### vol_type 电压查询类型

```c
#define BAT_VOL_MAIN   0  // 查询主电池电压
#define BAT_VOL_AUX    1  // 查询辅助电池电压
#define BAT_VOL_MAX    2  // 查询最大电压
#define BAT_VOL_MIN    3  // 查询最小电压
#define BAT_VOL_AVG    4  // 查询平均电压
```

---

## 五、DTS 配置

### 配置示例

```
battery_1s2p {
    compatible = "huawei,battery_1s2p";
    
    /* 全局配置 */
    vol_type = <4>;          // 使用平均电压
    cycle_type = <2>;        // 使用最大循环次数
    last_cap_type = <0>;     // 使用主电池最后容量
    temp_type = <0>;         // 温度类型（传递给 battery_temp）
    cap_diff_thr = <10>;     // 容量差异阈值 10%
    
    /* 主电池（BAT_MAIN）配置 */
    cap_ratio_0 = <50>;      // 容量占比 50%
    weight_factor_chg_0 = <30 50 70>;     // 充电权重
    weight_factor_dischg_0 = <40 50 60>;  // 放电权重
    volt_low_0 = <3400>;     // 低电压阈值 3400mV
    
    /* 辅助电池（BAT_AUX）配置 */
    cap_ratio_1 = <50>;
    weight_factor_chg_1 = <70 50 30>;
    weight_factor_dischg_1 = <60 50 40>;
    volt_low_1 = <3400>;
};
```

### 参数说明

| DTS 属性 | 类型 | 默认值 | 说明 |
|---------|------|-------|------|
| `cap_ratio_X` | u32 | 50 | 第 X 个电池容量占比（0-100） |
| `weight_factor_chg_X` | u32[3] | 无 | 充电权重因子数组（必须配置） |
| `weight_factor_dischg_X` | u32[3] | 无 | 放电权重因子数组（必须配置） |
| `volt_low` | u32 | 3500mV | 低电压阈值 |
| `cap_diff_thr` | u32 | 5% | 容量差异告警阈值 |

---

## 六、监控机制

### 6.1 工作队列 `bat_1s2p_monitor_work()`

**执行流程：**

```
┌─────────────────────────┐
│ 1. 获取 wakelock         │
├─────────────────────────┤
│ 2. 更新双电池信息        │
│    - bat_1s2p_update_bat_info() │
├─────────────────────────┤
│ 3. SOC 平滑处理          │
│    - bat_1s2p_smooth_soc() │
├─────────────────────────┤
│ 4. 故障检测与 DMD 上报   │
│    - bat_1s2p_detect_fault_send_dmd() │
├─────────────────────────┤
│ 5. 调整监控间隔          │
│    - bat_1s2p_select_work_interval() │
├─────────────────────────┤
│ 6. 释放 wakelock         │
├─────────────────────────┤
│ 7. 重新调度工作队列      │
└─────────────────────────┘
```

### 6.2 SOC 平滑算法

```c
if (abs(di->bat_info[i].soc - di->bat_info[i].last_soc) == 1) {
    // SOC 变化 ±1% 时不更新，避免频繁跳变
    di->bat_info[i].soc = di->bat_info[i].last_soc;
}
di->bat_info[i].last_soc = di->bat_info[i].soc;
```

---

## 七、驱动生命周期

### 7.1 初始化流程 `bat_1s2p_probe()`

1. **内存分配：** `devm_kzalloc()` 分配设备结构体
2. **DTS 解析：** `bat_1s2p_parse_dts()` 读取配置参数
3. **资源初始化：**
   - 注册 wakelock（防止休眠期间异常）
   - 初始化互斥锁 `mutex_init()`
   - 初始化延迟工作队列 `INIT_DELAYED_WORK()`
4. **双电池信息初始化：** `bat_1s2p_init_info()`
5. **启动监控：** 调度第一次工作队列
6. **注册 coul 接口：** `coul_interface_ops_register(&g_1s2p_ops)`

### 7.2 电源管理

```c
bat_1s2p_suspend():  取消延迟工作队列（省电）
bat_1s2p_resume():   立即调度工作队列（快速恢复监控）
```

### 7.3 模块加载优先级

```c
#ifdef CONFIG_COUL_DRV
rootfs_initcall(bat_1s2p_init);  // 依赖 coul 驱动时使用 rootfs 阶段
#else
device_initcall_sync(bat_1s2p_init);  // 否则使用 device 阶段
#endif
```

---

## 八、调试技巧

### 8.1 查看实时混合 SOC

```bash
cat /sys/class/power_supply/Battery/capacity  # 通过 coul_interface 获取的混合 SOC
```

### 8.2 动态调整监控间隔测试

修改 battery_1s2p.c 中的阈值：

```c
// 原代码
if (soc < 10 || soc >= 90)
    di->interval = BAT_1S2P_WORK_INTERVAL_FAST;

// 调试代码（全时段快速监控）
di->interval = BAT_1S2P_WORK_INTERVAL_FAST;
```

### 8.3 监控 DMD 告警

```bash
dmesg | grep "battery_1s2p"
```

常见日志：
```
battery_1s2p: battery0 missing  # 主电池缺失
battery_1s2p: battery1 missing  # 辅助电池缺失
battery_1s2p: capacity_diff=15% # 容量差异超过阈值
```

### 8.4 验证加权算法

在 battery_1s2p.c 末尾添加日志：

```c
hwlog_info("mix_soc=%d (main:%d×%u + aux:%d×%u) / %u\n",
    mix_soc,
    di->bat_info[BAT_MAIN].soc, weight[BAT_MAIN],
    di->bat_info[BAT_AUX].soc, weight[BAT_AUX],
    weight[BAT_MAIN] + weight[BAT_AUX]);
```

---

## 九、关键宏定义

```c
#define BAT_1S2P_WORK_INTERVAL_FAST   10000  // 快速监控间隔（10秒）
#define BAT_1S2P_WORK_INTERVAL_SLOW   60000  // 慢速监控间隔（60秒）
#define VOLT_HIGH_THRESHOLD           4200   // 高电压阈值（mV）
#define VOLT_LOW_THRESHOLD            3500   // 低电压阈值（mV）
#define CAP_RATIO_MAX                 100    // 容量比例最大值
#define WEIGHT_FACTOR_COUNT           3      // 权重因子数量
```

---

## 十、总结

battery_1s2p.c 通过**多维度加权融合算法**将双电池系统抽象为单一电池，核心亮点包括：

1. **自适应权重机制：** 根据电压区间和充放电状态动态调整融合权重
2. **智能监控策略：** 在关键 SOC 区间提高监控频率，平衡性能与功耗
3. **容错设计：** 通过 DMD 机制及时发现电池缺失或异常差异
4. **灵活配置：** 支持 DTS 动态配置容量比例、权重因子等参数

该模块是华为折叠屏等多电池设备的核心电源管理组件，确保了双电池系统的可靠性和用户体验一致性。