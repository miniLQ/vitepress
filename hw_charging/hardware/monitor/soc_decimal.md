---
outline: deep
---

# SOC Decimal 模块分析

## 一、模块概述

### 1.1 功能定位
**SOC Decimal (带小数点的电量计算)** 是华为 MATE X5 电源管理系统中的**高精度电量显示模块**，主要用于在**快充/无线快充场景下**，通过软件算法实现**带小数位的电量计算**（如 75.3%），从而提供更**平滑、更精确的电量显示体验**，避免电量跳变。

### 1.2 核心功能
- **小数电量计算**：将电量精度从整数（如 75%）提升到带小数（如 75.3%，内部以 753 表示）
- **平滑算法**：通过滑动窗口滤波，避免电量显示剧烈波动
- **快充优化**：针对直充（DC）和无线快充（WL_DC）不同功率段配置不同参数
- **分段策略**：根据电量区间（0-80%、80-90%、90-100%）采用不同增长速率
- **定时采样**：周期性（默认 140ms）采样和计算，实时更新电量

### 1.3 设计背景
**传统电量显示问题**：
- 电量以整数显示（0%-100%），精度低
- 快充时电量跳变明显（如 74% → 75% → 76%）
- 用户体验差，无法感知充电进度的连续性

**SOC Decimal 解决方案**：
- 内部计算小数电量（如 753 表示 75.3%）
- 快充时平滑增长，用户感知更连续
- 通过滑动窗口滤波消除波动
- 提升高端旗舰机的体验差异化

**应用场景**：
- **超级快充**：40W/66W/100W+ 功率下的平滑电量显示
- **无线快充**：无线 DC 快充的精细电量展示
- **高端机型**：旗舰机的体验优化

---

## 二、系统架构

### 2.1 模块组成
```
soc_decimal 模块
├── soc_decimal.c       # 主逻辑（算法、定时器、滤波）
├── soc_decimal.h       # 数据结构定义
├── Kconfig             # 内核配置
└── Makefile            # 编译配置
```

### 2.2 架构分层
```
+---------------------------------------------------------------+
|                    User Space (SystemUI)                      |
|  读取: /sys/class/hw_power/soc_decimal/soc                    |
|  控制: echo "system_ui 1" > start                             |
+---------------------------------------------------------------+
                              ↓
+---------------------------------------------------------------+
|              SOC Decimal Core (soc_decimal.c)                 |
|  计算引擎:                                                     |
|    - soc_decimal_calculate_soc(): 小数电量计算                |
|    - soc_decimal_pulling_fifo(): 滑动窗口滤波                 |
|  定时器:                                                      |
|    - hrtimer: 高精度定时器（140ms 周期）                      |
|    - timer_work: 定时采样和计算                               |
|  参数选择:                                                     |
|    - 根据充电功率选择对应参数级别                              |
+---------------------------------------------------------------+
                              ↓
+---------------------------------------------------------------+
|              Power Platform Interface                         |
|  - power_platform_get_filter_soc(): 获取原始电量              |
|  - power_platform_sync_filter_soc(): 同步计算结果            |
|  - power_platform_cancle_capacity_work(): 取消原有工作队列   |
|  - power_platform_restart_capacity_work(): 恢复工作队列       |
+---------------------------------------------------------------+
                              ↓
+---------------------------------------------------------------+
|              Fuel Gauge (电量计芯片)                          |
|  - 库仑计计算原始电量（整数精度）                              |
|  - 提供电流、电压等数据                                        |
+---------------------------------------------------------------+
```

### 2.3 工作流程
```
快充启动（如 40W 直充）
    ↓
POWER_NE_SOC_DECIMAL_DC 事件 + 功率 40W
    ↓
soc_decimal_select_para_level() 选择参数级别
    ↓
SystemUI 启动小数电量计算
    ↓
echo "system_ui 1" > /sys/class/hw_power/soc_decimal/start
    ↓
soc_decimal_init_fifo() 初始化滑动窗口
    ↓
启动 hrtimer（140ms 周期）
    ↓
┌─────────────────────────────────────────────────┐
│  每 140ms 执行一次:                              │
│                                                 │
│  1. 读取当前电量 (如 UI 显示 75%)               │
│                                                 │
│  2. 根据电量区间计算增量:                        │
│     - 0-80%: curr_soc = init_soc + (samples/3) + 3 │
│     - 80-90%: curr_soc = init_soc + (samples/4)│
│     - 90-100%: curr_soc = init_soc + (samples/5)   │
│                                                 │
│  3. 滑动窗口滤波 (20 个样本):                    │
│     rep_soc = sum / 20                          │
│                                                 │
│  4. 同步到 Power Platform                       │
│     sync_filter_soc(rep_soc)                    │
│                                                 │
│  5. 增加样本计数器 curr_samples++               │
│                                                 │
│  6. 达到最大样本数 (85 个) → 停止定时器         │
└─────────────────────────────────────────────────┘
    ↓
SystemUI 读取小数电量
    ↓
cat /sys/class/hw_power/soc_decimal/soc
    ↓
返回: 753 (表示 75.3%)
    ↓
SystemUI 显示: 75%（内部保存小数部分用于动画）
```

---

## 三、核心数据结构

### 3.1 参数数据结构
```c
struct soc_decimal_para_data {
    u32 type;       // 充电类型（DC/WL_DC）
    u32 min_pwr;    // 最小功率（W，如 25W）
    u32 max_pwr;    // 最大功率（W，如 50W）
    u32 base;       // 电量基数（10=1位小数, 100=2位小数）
    u32 samples;    // 最大采样次数（如 85 次）
    u32 interval;   // 采样间隔（ms，如 140ms）
};
```

**参数说明**：
- `type`：0=有线直充（DC），1=无线直充（WL_DC）
- `min_pwr/max_pwr`：功率范围，用于匹配参数级别
- `base`：**关键参数**，决定小数位数
  - `base=10`：1 位小数（如 75.3% → 753）
  - `base=100`：2 位小数（如 75.36% → 7536）
- samples：最大采样次数，控制计算持续时间
  - `samples=85`，`interval=140ms` → 总时长 85 × 0.14s = **11.9 秒**
- `interval`：采样周期，140ms 保证平滑更新

### 3.2 滑动窗口数据结构
```c
struct soc_decimal_fifo_data {
    u32 filter[SOC_DECIMAL_WINDOW_LEN];  // 滤波窗口（20 个样本）
    u32 sum;                              // 窗口样本总和
    u32 index;                            // 当前插入位置（循环）
    u32 curr_samples;                     // 当前采样次数
    u32 init_soc;                         // 初始电量（启动时电量）
};
```

**滑动窗口原理**（环形缓冲区）：
```
窗口大小: 20 个样本
示例数据: [751, 752, 753, 754, 755, ...]

计算平均值:
rep_soc = sum / 20
        = (751 + 752 + ... + 770) / 20
        = 760.5 → 760
```

### 3.3 计算数据结构
```c
struct soc_decimal_calc_data {
    int base;          // 电量基数（如 10）
    int samples;       // 最大采样次数（如 85）
    int curr_samples;  // 当前采样次数（如 10）
    int init_soc;      // 初始电量（如 750 = 75.0%）
    int curr_soc;      // 当前计算电量（如 753）
    int rep_soc;       // 滤波后电量（如 752）
    int round_soc;     // 整数部分（如 75）
    int remain_soc;    // 小数部分（如 2 → 0.2%）
};
```

### 3.4 设备管理结构
```c
struct soc_decimal_dev {
    struct device *dev;                  // Sysfs 设备节点
    struct notifier_block nb;            // 充电事件通知器
    struct notifier_block soc_nb;        // SOC Decimal 事件通知器
    struct hrtimer timer;                // 高精度定时器
    struct work_struct soc_decimal_timer_work;  // 定时工作队列
    
    // 参数配置（最多 8 个级别）
    int para_level;                      // 参数级别总数
    struct soc_decimal_para_data para[SOC_DECIMAL_PARA_LEVEL];
    
    // 运行时信息
    u32 ui_offset;                       // UI 显示偏移
    struct soc_decimal_info info;        // 当前运行状态
};

struct soc_decimal_info {
    bool start;                          // 是否启动计算
    u32 soc;                             // 当前小数电量
    int level;                           // 当前参数级别（-1=未选择）
    struct soc_decimal_fifo_data fifo;   // 滑动窗口数据
    struct soc_decimal_para_data para;   // 当前参数
};
```

---

## 四、核心算法与工作流程

### 4.1 小数电量计算算法（soc_decimal_calculate_soc）

```c
static u32 soc_decimal_calculate_soc(struct soc_decimal_dev *l_dev)
{
    struct soc_decimal_calc_data calc;
    
    calc.base = l_dev->info.para.base;           // 如 10
    calc.samples = l_dev->info.para.samples;     // 如 85
    calc.curr_samples = l_dev->info.fifo.curr_samples;  // 如 10
    calc.init_soc = l_dev->info.fifo.init_soc;   // 如 750 (75.0%)
    
    // 1. 检查采样次数
    if (calc.curr_samples < calc.samples) {
        // 2. 根据电量区间计算增量（分段策略）
        if (calc.init_soc < 80 * calc.base) {  // 0-80%
            // 增长快: samples/3 + 3
            calc.curr_soc = calc.init_soc + (calc.curr_samples / 3) + 3;
        } else if ((calc.init_soc >= 80 * calc.base) &&
                   (calc.init_soc < 90 * calc.base)) {  // 80-90%
            // 增长中等: samples/4
            calc.curr_soc = calc.init_soc + (calc.curr_samples / 4);
        } else {  // 90-100%
            // 增长慢: samples/5
            calc.curr_soc = calc.init_soc + (calc.curr_samples / 5);
        }
        
        l_dev->info.fifo.curr_samples++;
    } else {
        // 3. 达到最大采样次数，使用原始电量
        return power_platform_get_filter_soc(calc.base);
    }
    
    // 4. 滑动窗口滤波
    calc.rep_soc = soc_decimal_pulling_fifo(l_dev, calc.curr_soc);
    
    // 5. 分离整数和小数部分
    calc.round_soc = calc.rep_soc / calc.base;    // 75
    calc.remain_soc = calc.rep_soc % calc.base;   // 2 (0.2%)
    
    hwlog_info("samples[%d]: curr_soc=%d rep_soc=%d round=%d remain=%d\n",
        l_dev->info.fifo.curr_samples,
        calc.curr_soc, calc.rep_soc, calc.round_soc, calc.remain_soc);
    
    // 6. 同步到 Power Platform
    power_platform_sync_filter_soc(calc.rep_soc, calc.round_soc, calc.base);
    
    return calc.rep_soc;
}
```

**分段增长策略解释**：

| 电量区间 | 增长公式 | 示例（base=10, curr_samples=30） | 说明 |
|----------|----------|--------------------------------|------|
| 0-80% | `init + samples/3 + 3` | 750 + 30/3 + 3 = 763 | 快速增长，改善低电量体验 |
| 80-90% | `init + samples/4` | 850 + 30/4 = 857 | 中速增长 |
| 90-100% | `init + samples/5` | 950 + 30/5 = 956 | 慢速增长，接近满电谨慎 |

**增长曲线示例**（init_soc=750, base=10, samples=85）：

```
samples  curr_soc  增量说明
------   --------  --------
0        750       初始值 (75.0%)
10       756       +6  (10/3 + 3 = 6)
20       759       +9  (20/3 + 3 = 9)
30       763       +13 (30/3 + 3 = 13)
...
85       778       +28 (85/3 + 3 = 31，但受滤波影响)
```

### 4.2 滑动窗口滤波算法（soc_decimal_pulling_fifo）

```c
static u32 soc_decimal_pulling_fifo(struct soc_decimal_dev *l_dev, u32 soc)
{
    int index;
    
    // 1. 计算当前插入位置（循环索引）
    index = l_dev->info.fifo.index % SOC_DECIMAL_WINDOW_LEN;  // % 20
    
    // 2. 减去旧值（即将被替换的值）
    l_dev->info.fifo.sum -= l_dev->info.fifo.filter[index];
    
    // 3. 插入新值
    l_dev->info.fifo.filter[index] = soc;
    
    // 4. 加上新值
    l_dev->info.fifo.sum += soc;
    
    // 5. 索引递增
    l_dev->info.fifo.index++;
    
    // 6. 返回平均值
    return l_dev->info.fifo.sum / SOC_DECIMAL_WINDOW_LEN;
}
```

**滤波效果示例**：

```
时刻  输入 curr_soc  窗口数据                           平均值 rep_soc
----  ------------  --------------------------------  --------------
T0    753           [753,753,753,...,753] (20个)      753
T1    754           [754,753,753,...,753]             753.05 → 753
T2    755           [755,754,753,...,753]             753.10 → 753
T3    756           [756,755,754,...,753]             753.15 → 753
...
T10   763           [763,762,761,...,754]             757.5 → 757
```

**滤波作用**：
- 消除单次采样的波动
- 平滑电量变化曲线
- 避免显示跳变

### 4.3 滑动窗口初始化（soc_decimal_init_fifo）

```c
static void soc_decimal_init_fifo(struct soc_decimal_dev *l_dev)
{
    int curr_soc;
    int ui_soc;
    int i;
    
    // 1. 读取原始电量（带 base 倍数）
    curr_soc = power_platform_get_filter_soc(l_dev->info.para.base);
    
    // 2. 读取 UI 显示电量（整数百分比）
    ui_soc = power_supply_app_get_bat_capacity() * 10;  // 75% → 750
    
    // 3. 取较大值（防止显示倒退）
    curr_soc = curr_soc < ui_soc ? ui_soc : curr_soc;
    
    // 4. 初始化窗口（所有样本填充相同值）
    l_dev->info.fifo.sum = 0;
    for (i = 0; i < SOC_DECIMAL_WINDOW_LEN; i++) {
        l_dev->info.fifo.filter[i] = curr_soc;
        l_dev->info.fifo.sum += curr_soc;
    }
    
    // 5. 重置状态
    l_dev->info.fifo.index = 0;
    l_dev->info.fifo.curr_samples = 0;
    l_dev->info.fifo.init_soc = curr_soc;
    l_dev->info.soc = curr_soc;
    
    hwlog_info("init decimal_soc=%d, ui_soc=%d\n",
        l_dev->info.fifo.init_soc, ui_soc);
}
```

**初始化策略**：
- 使用 `max(curr_soc, ui_soc)` 防止电量倒退
- 窗口填充相同值，避免初始波动

### 4.4 参数级别选择（soc_decimal_select_para_level）

```c
static void soc_decimal_select_para_level(struct soc_decimal_dev *l_dev,
    int type, const void *data)
{
    u32 power;
    int i;
    
    if (!data)
        goto fail_get_level;
    
    power = *(u32 *)data;  // 充电功率（如 40W）
    
    hwlog_info("power=%d, para_level=%d\n", power, l_dev->para_level);
    
    // 遍历所有参数级别
    for (i = 0; i < l_dev->para_level; i++) {
        // 匹配类型和功率范围
        if ((type == l_dev->para[i].type) &&
            (power >= l_dev->para[i].min_pwr) &&
            (power < l_dev->para[i].max_pwr)) {
            l_dev->info.level = i;
            return;
        }
    }
    
fail_get_level:
    l_dev->info.level = SOC_DECIMAL_DEFAULT_LEVEL;  // -1（未匹配）
}
```

**匹配示例**（DTS 配置）：
```dts
para = <
    /* type  min_pwr  max_pwr  base  samples  interval */
    0       0        30       10    85       140    /* DC 0-30W */
    0       30       50       10    100      120    /* DC 30-50W */
    0       50       100      10    120      100    /* DC 50-100W */
    1       0        20       10    85       140    /* WL_DC 0-20W */
>;
```

**匹配过程**：
```
输入: type=0 (DC), power=40W
    ↓
检查 level 0: DC 0-30W   → 不匹配（40 >= 30）
检查 level 1: DC 30-50W  → 匹配！ ✓
    ↓
选择: level = 1
参数: base=10, samples=100, interval=120ms
```

---

## 五、Sysfs 接口

### 5.1 节点路径
```bash
/sys/class/hw_power/soc_decimal/
├── start    # 只写：启动/停止小数电量计算
├── soc      # 只读：当前小数电量
├── level    # 只读：当前参数级别
└── para     # 只读：所有参数配置
```

### 5.2 接口说明

#### start（只写）

**写入格式**：
```bash
echo "<user> <value>" > start

# 参数说明：
# user: 操作用户（目前仅支持 "system_ui"）
# value: 0=停止, 1=启动
```

**使用示例**：
```bash
# 启动小数电量计算
echo "system_ui 1" > /sys/class/hw_power/soc_decimal/start

# 停止计算
echo "system_ui 0" > /sys/class/hw_power/soc_decimal/start
```

**启动流程**：
```c
1. 等待 10ms，确保 level 参数更新
2. 检查 level 是否有效（-1 表示未选择参数）
3. 复制当前 level 的参数到 info.para
4. 初始化滑动窗口 (soc_decimal_init_fifo)
5. 启动定时器 (soc_decimal_timer_start)
6. 取消原有电量计算工作队列
```

#### soc（只读）

```bash
cat /sys/class/hw_power/soc_decimal/soc
# 输出：753 (表示 75.3%)
```

**计算逻辑**：
```c
if (!start)
    soc = power_platform_get_filter_soc(100);  // 未启动，返回原始电量
else if (level == -1)
    soc = power_platform_get_filter_soc(100);  // 未选择参数，返回原始电量
else
    soc = l_dev->info.soc;  // 返回计算的小数电量

return soc + ui_offset;  // 加上 UI 偏移
```

#### level（只读）

```bash
cat /sys/class/hw_power/soc_decimal/level
# 输出：1（当前使用参数级别 1）
# 输出：-1（未选择参数）
```

#### para（只读）

```bash
cat /sys/class/hw_power/soc_decimal/para
# 输出格式：
# type min_pwr max_pwr base samples interval
# 0 0 30 10 85 140
# 0 30 50 10 100 120
# 0 50 100 10 120 100
# 1 0 20 10 85 140
```

---

## 六、典型应用场景

### 6.1 场景1：40W 有线快充

```
充电开始：
1. 充电功率达到 40W
   ↓
2. 充电框架发送事件：
   power_event_bnc_notify(POWER_BNT_SOC_DECIMAL,
       POWER_NE_SOC_DECIMAL_DC, &power=40);
   ↓
3. soc_decimal 匹配参数级别：
   type=0 (DC), power=40W
   → 匹配到 level 1 (DC 30-50W)
   → base=10, samples=100, interval=120ms
   ↓
4. SystemUI 启动小数电量计算：
   echo "system_ui 1" > /sys/class/hw_power/soc_decimal/start
   ↓
5. 初始化：
   - 读取当前电量: UI=75%, 原始=750
   - 初始化窗口: [750, 750, ..., 750]
   - 启动定时器: 120ms 周期
   ↓
6. 定时计算（每 120ms）：
   Sample 0:  curr_soc=753 (750+0/3+3), rep_soc=750, 显示 75.0%
   Sample 10: curr_soc=756 (750+10/3+3), rep_soc=753, 显示 75.3%
   Sample 20: curr_soc=759 (750+20/3+3), rep_soc=756, 显示 75.6%
   ...
   Sample 100: 达到最大采样，停止定时器
   ↓
7. SystemUI 读取电量：
   cat /sys/class/hw_power/soc_decimal/soc
   → 返回 756 (75.6%)
   ↓
8. SystemUI 显示：
   - UI 显示: 75%（整数）
   - 内部保存小数部分用于进度条动画
   - 下次更新可能显示 76%（当 rep_soc >= 760）

充电结束：
1. 充电停止事件
   ↓
2. soc_decimal 复位：
   level = -1
   start = false
   ↓
3. 恢复原有电量计算
```

### 6.2 场景2：无线快充 15W

```
充电开始：
1. 无线充电功率 15W
   ↓
2. 事件通知：
   power_event_bnc_notify(POWER_BNT_SOC_DECIMAL,
       POWER_NE_SOC_DECIMAL_WL_DC, &power=15);
   ↓
3. 参数匹配：
   type=1 (WL_DC), power=15W
   → 匹配到 level 3 (WL_DC 0-20W)
   → base=10, samples=85, interval=140ms
   ↓
4. SystemUI 启动计算
   ↓
5. 定时计算（每 140ms）
   Sample 0:  电量 850 (85.0%)
   Sample 10: 电量 852 (85.2%) [850 + 10/4 = 852]
   Sample 20: 电量 855 (85.5%) [850 + 20/4 = 855]
   ...

特点：
- 无线充电功率较低，interval 较长（140ms）
- 80-90% 区间增长速率为 samples/4
- 更平缓的电量增长曲线
```

### 6.3 场景3：超级快充 66W

```
充电开始：
1. 充电功率达到 66W
   ↓
2. 参数匹配：
   type=0 (DC), power=66W
   → 匹配到 level 2 (DC 50-100W)
   → base=10, samples=120, interval=100ms
   ↓
3. 启动计算
   ↓
4. 定时计算（每 100ms）：
   - interval 更短（100ms），更新更频繁
   - samples 更多（120），总时长 12 秒
   - 电量增长更快，匹配快充速度

效果：
- 100ms 更新一次，电量显示更流畅
- 12 秒内完成一个电量段的平滑过渡
- 匹配 66W 快充的实际充电速度
```

### 6.4 场景4：低电量充电（30%）

```
充电开始：
初始电量: 30.0% (300)

定时计算（0-80% 区间）：
Sample 0:  300 + 0/3 + 3 = 303 (30.3%)
Sample 10: 300 + 10/3 + 3 = 306 (30.6%)
Sample 20: 300 + 20/3 + 3 = 309 (30.9%)
Sample 30: 300 + 30/3 + 3 = 313 (31.3%)
...

特点：
- 使用 samples/3 + 3 公式，增长最快
- 快速改善低电量焦虑
- 每 30 个样本约增长 1.3%（3.6 秒）
```

---

## 七、调试方法

### 7.1 日志关键点
```bash
# 1. 参数级别选择
[soc_decimal] power=40, para_level=4

# 2. 滑动窗口初始化
[soc_decimal] init decimal_soc=750, ui_soc=750

# 3. 每次采样计算
[soc_decimal] samples[10]: curr_soc=756 rep_soc=753 round=75 remain=3

# 4. 启动控制
[soc_decimal] set: user=system_ui, start=1, level=1, para_level=4

# 5. 停止事件
[soc_decimal] ignore the same start event
```

### 7.2 Sysfs 调试
```bash
# 查看当前小数电量
cat /sys/class/hw_power/soc_decimal/soc
# 输出: 753

# 查看当前参数级别
cat /sys/class/hw_power/soc_decimal/level
# 输出: 1

# 查看所有参数配置
cat /sys/class/hw_power/soc_decimal/para
# 输出:
# 0 0 30 10 85 140
# 0 30 50 10 100 120
# 0 50 100 10 120 100
# 1 0 20 10 85 140
```

### 7.3 实时监控脚本
```bash
#!/bin/bash
# soc_decimal_monitor.sh

while true; do
    SOC=$(cat /sys/class/hw_power/soc_decimal/soc)
    LEVEL=$(cat /sys/class/hw_power/soc_decimal/level)
    UI_SOC=$(cat /sys/class/power_supply/battery/capacity)
    
    # 计算整数和小数部分
    INTEGER=$((SOC / 10))
    DECIMAL=$((SOC % 10))
    
    echo "$(date '+%H:%M:%S') Decimal=$SOC (${INTEGER}.${DECIMAL}%) UI=$UI_SOC% Level=$LEVEL"
    sleep 1
done

# 运行示例:
# chmod +x soc_decimal_monitor.sh
# ./soc_decimal_monitor.sh

# 输出示例:
# 10:00:00 Decimal=750 (75.0%) UI=75% Level=1
# 10:00:01 Decimal=752 (75.2%) UI=75% Level=1
# 10:00:02 Decimal=754 (75.4%) UI=75% Level=1
# 10:00:03 Decimal=756 (75.6%) UI=75% Level=1
# 10:00:04 Decimal=758 (75.8%) UI=75% Level=1
# 10:00:05 Decimal=760 (76.0%) UI=76% Level=1  ← UI 跳变到 76%
```

### 7.4 常见问题排查

#### 问题1：小数电量未生效
**现象**：读取 soc 返回整数电量（如 750）

**排查步骤**：
1. 检查是否启动：
   ```bash
   dmesg | grep "set: user=system_ui, start=1"
   ```
2. 检查 level 是否有效：
   ```bash
   cat /sys/class/hw_power/soc_decimal/level
   # 应该 >= 0，-1 表示未匹配参数
   ```
3. 检查充电功率是否在配置范围内：
   ```bash
   cat /sys/class/power_supply/usb/voltage_now
   cat /sys/class/power_supply/usb/current_now
   # 计算功率: P = V × I
   ```

#### 问题2：电量增长过快
**现象**：小数电量增长速度远超实际充电速度

**原因分析**：
- samples 配置过小
- `interval` 配置过短
- 分段公式系数过大

**解决方案**：
```dts
/* 调整 DTS 参数 */
para = <
    /* 增大 samples 延长计算时间 */
    0 30 50 10 150 120    /* samples: 100 → 150 */
>;
```

#### 问题3：电量显示卡顿
**现象**：小数电量长时间不变，然后突然跳变

**原因分析**：
- 滑动窗口尺寸过大（20 个样本）
- interval 过长

**解决方案**：
```c
// 减小窗口尺寸（需重新编译）
#define SOC_DECIMAL_WINDOW_LEN  10  // 改为 10

// 或缩短采样周期
para = <
    0 30 50 10 100 80     /* interval: 120ms → 80ms */
>;
```

#### 问题4：定时器未启动
**现象**：日志无 "samples[X]" 输出

**排查步骤**：
1. 检查 hrtimer 是否初始化：
   ```bash
   dmesg | grep "hrtimer_init"
   ```
2. 检查 level 和 start 状态：
   ```bash
   cat /sys/class/hw_power/soc_decimal/level  # 应 >= 0
   dmesg | grep "start=1"
   ```
3. 检查 samples 是否已用尽：
   ```bash
   dmesg | grep "samples\["
   # 如果显示 samples[85]，说明已达上限
   ```

---

## 八、DTS 配置说明

### 8.1 完整配置示例
```dts
soc_decimal {
    compatible = "huawei,soc_decimal";
    status = "ok";
    
    /* UI 显示偏移（可选） */
    ui_offset = <0>;
    
    /* 参数配置数组 */
    para = <
        /* type  min_pwr  max_pwr  base  samples  interval */
        
        /* DC（有线直充）参数 */
        0       0        30       10    85       140     /* DC 0-30W */
        0       30       50       10    100      120     /* DC 30-50W */
        0       50       100      10    120      100     /* DC 50-100W */
        
        /* WL_DC（无线直充）参数 */
        1       0        20       10    85       140     /* WL_DC 0-20W */
    >;
};
```

### 8.2 参数说明

| 字段 | 说明 | 示例 | 备注 |
|------|------|------|------|
| type | 充电类型 | 0=DC, 1=WL_DC | 用于匹配充电模式 |
| min_pwr | 最小功率（W） | 30 | 功率范围下限 |
| max_pwr | 最大功率（W） | 50 | 功率范围上限 |
| base | 电量基数 | 10 | 10=1位小数, 100=2位小数 |
| samples | 最大采样次数 | 100 | 控制计算持续时间 |
| interval | 采样间隔（ms） | 120 | 定时器周期 |

### 8.3 参数调优指南

#### 计算持续时间
```
总时长 = samples × interval / 1000 秒

示例1: samples=85, interval=140ms
    → 总时长 = 85 × 0.14s = 11.9 秒

示例2: samples=120, interval=100ms
    → 总时长 = 120 × 0.1s = 12 秒
```

#### 电量增长速率
```
0-80%:  增量 ≈ samples / 3
80-90%: 增量 ≈ samples / 4
90-100%: 增量 ≈ samples / 5

示例（samples=100, base=10）:
0-80%:  最大增量 = 100/3 + 3 = 36 → 3.6%
80-90%: 最大增量 = 100/4 = 25 → 2.5%
90-100%: 最大增量 = 100/5 = 20 → 2.0%
```

#### 适配不同功率
| 功率范围 | 建议 interval | 建议 samples | 总时长 |
|----------|--------------|--------------|--------|
| 0-30W | 140ms | 85 | 11.9s |
| 30-50W | 120ms | 100 | 12s |
| 50-100W | 100ms | 120 | 12s |
| 100W+ | 80ms | 150 | 12s |

---

## 九、总结

### 9.1 技术特点
1. **高精度计算**：支持小数电量（base=10 或 100）
2. **平滑滤波**：20 个样本滑动窗口消除波动
3. **分段策略**：不同电量区间采用不同增长速率
4. **多场景适配**：支持有线/无线快充不同功率段

### 9.2 设计亮点
- **定时器驱动**：hrtimer 高精度定时器（ms 级）
- **环形缓冲**：滑动窗口优化内存和计算效率
- **参数化配置**：DTS 灵活配置适配不同充电器
- **平台解耦**：通过 power_platform 接口与底层隔离

### 9.3 应用价值
- **提升体验**：平滑电量显示，改善快充用户感知
- **差异化竞争**：旗舰机型的体验优化亮点
- **技术储备**：为未来更高精度显示（如 0.1% 刻度）打基础

### 9.4 局限性
- **仅限快充**：普通充电未启用（功率低，效果不明显）
- **计算开销**：定时器和滤波增加 CPU 负载（虽然很小）
- **依赖 UI**：需要 SystemUI 主动启动和读取
- **精度限制**：受电量计芯片精度影响

### 9.5 改进方向
1. **自适应参数**：
   - 根据实际充电速度动态调整 samples
   - 根据电池温度调整增长速率

2. **更高精度**：
   - 支持 base=100（两位小数，如 75.36%）
   - 提供百分位刻度显示

3. **AI 优化**：
   - 机器学习预测电量变化趋势
   - 自适应调整滤波窗口大小

4. **节能优化**：
   - 屏幕关闭时降低采样频率
   - 电量稳定时暂停计算
