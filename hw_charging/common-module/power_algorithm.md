---
outline: deep
---

# Power Algorithm 模块分析

## 1. 模块定位与核心价值

### 1.1 模块定位
**power_algorithm** 是华为MATE X5电源管理子系统的**通用算法库**，提供一套**数据处理和数学运算工具函数**，用于电源管理中的各种数值计算、补偿、滤波和数据转换场景。它是电源管理子系统的**数学基础设施层**。

### 1.2 核心价值
1. **数据补偿算法**：温度补偿、ADC补偿、平滑补偿等
2. **迟滞算法**：防止数据抖动的迟滞逻辑
3. **数学工具函数**：线性插值、查表转换、统计计算
4. **字符串处理**：轻量级正则表达式匹配、子串提取
5. **通用性强**：与具体硬件解耦，可复用于各种电源场景

### 1.3 典型应用场景
- **温度补偿**：根据温度对电压/电流测量值进行修正
- **电池老化补偿**：根据循环次数补偿容量值
- **ADC地线补偿**：消除地线压降对ADC测量的影响
- **充电电流平滑**：避免充电电流突变
- **迟滞控制**：温控档位切换时的防抖动

---

## 2. 算法分类与架构

### 2.1 算法分类图
```
power_algorithm 算法库
│
├── 补偿算法 (Compensation)
│   ├── 通用补偿 (power_get_compensation_value)
│   ├── 平滑补偿 (power_get_smooth_compensation_value)
│   └── ADC地线补偿 (power_get_adc_compensation_value)
│
├── 迟滞算法 (Hysteresis)
│   └── 通用迟滞 (power_get_hysteresis_index)
│
├── 数学运算 (Math)
│   ├── 统计函数 (min/max/average)
│   ├── 线性插值 (power_linear_interpolate)
│   ├── 查表转换 (power_lookup_table_linear_trans_dichotomy)
│   ├── 正负数处理 (power_min_positive/power_max_positive)
│   └── 向上取整 (power_ceil)
│
├── 数据处理 (Data Process)
│   ├── 混合算法 (power_get_mixed_value)
│   ├── 数值转换 (power_convert_value)
│   └── 字符转数字 (power_change_char_to_digit)
│
└── 字符串工具 (String Utility)
    ├── 子串提取 (power_sub_str)
    ├── 字符查找 (power_find_first_char)
    └── 轻量级正则 (power_regex_lite_is_matched)
```

---

## 3. 核心数据结构

### 3.1 迟滞参数结构
```c
struct hysteresis_para {
    int refer_lth;    // 参考值下限（Low Threshold）
    int refer_hth;    // 参考值上限（High Threshold）
    int hys_value;    // 迟滞值
};

struct common_hys_data {
    int refer;                      // 当前参考值（如温度）
    int para_size;                  // 参数表大小
    struct hysteresis_para *para;   // 迟滞参数表
};
```

**使用场景**：温控档位切换
```
温度区间表：
┌─────────────┬─────────────┬─────────────┐
│  [0, 25)    │  [25, 45)   │  [45, 60]   │
│  档位0      │  档位1      │  档位2      │
│  迟滞5°C    │  迟滞3°C    │  迟滞2°C    │
└─────────────┴─────────────┴─────────────┘

当前档位1，温度24°C：
  if (25 - 24 > 3)  // 下降未超过迟滞值
      保持档位1     // 避免频繁切换
  else
      切换到档位0
```

### 3.2 补偿参数结构
```c
struct compensation_para {
    int refer;        // 参考值（如温度）
    int comp_value;   // 补偿值
};

struct common_comp_data {
    int refer;                         // 当前参考值
    int para_size;                     // 参数表大小
    struct compensation_para *para;    // 补偿参数表
};
```

**使用场景**：温度补偿电压
```c
// 温度补偿表：温度越高，电压测量值越高，需要负补偿
struct compensation_para temp_comp_table[] = {
    { 60, 50 },   // 60°C以上，补偿+50mV
    { 40, 20 },   // 40°C以上，补偿+20mV
    { 20, 0 },    // 20°C以上，补偿0
    { 0, -30 },   // 0°C以上，补偿-30mV
};

// 当前温度45°C，测量电压4200mV
// 补偿后：4200 - 20 = 4180mV
```

### 3.3 平滑补偿结构
```c
struct smooth_comp_data {
    int current_comp;   // 当前补偿后值
    int current_raw;    // 当前原始值
    int last_comp;      // 上次补偿后值
    int last_raw;       // 上次原始值
    int max_delta;      // 最大变化量
};
```

**防止异常跳变**：
- 如果补偿值和原始值变化趋势相反 → 保持上次值
- 如果补偿值变化大于原始值 → 限制为原始值变化量
- 如果变化超过max_delta → 限制在max_delta范围内

### 3.4 ADC补偿结构
```c
struct adc_comp_data {
    u32 adc_accuracy;   // ADC精度（位数，如12bit）
    int adc_v_ref;      // ADC参考电压（mV）
    int v_pullup;       // 上拉电压（mV）
    int r_pullup;       // 上拉电阻（Ω）
    int r_comp;         // 补偿电阻（地线电阻，Ω）
};
```

**电路模型**：
```
VCC (v_pullup)
  │
  R_pullup
  │
  ├───> ADC测量点 (v_adc)
  │
  R_NTC (待求)
  │
  R_comp (地线电阻)
  │
 GND
```

---

## 4. 核心算法实现

### 4.1 通用迟滞算法
```c
int power_get_hysteresis_index(int index, const struct common_hys_data *data)
{
    int i, refer, refer_lth, hys_value;
    int new_index = index;

    refer = data->refer;              // 当前参考值（如温度）
    refer_lth = data->para[index].refer_lth;  // 当前档位下限
    hys_value = data->para[index].hys_value;  // 迟滞值

    // 遍历所有档位
    for (i = 0; i < data->para_size; i++) {
        // 判断当前参考值落在哪个区间
        if ((refer >= data->para[i].refer_lth) &&
            (refer < data->para[i].refer_hth)) {
            
            // 向下切换：需要超过迟滞值才切换
            if ((index > i) && (refer_lth - refer > hys_value)) {
                new_index = i;
                break;
            } 
            // 向上切换：直接切换
            else if (index < i) {
                new_index = i;
                break;
            }
            break;
        }
    }

    return new_index;
}
```

**实际案例**：温控档位切换
```
档位表：
  档位0: [0,  25°C)  迟滞5°C
  档位1: [25, 45°C)  迟滞3°C
  档位2: [45, 60°C]  迟滞2°C

场景1：当前档位1（25-45°C），温度下降到24°C
  refer_lth = 25
  refer = 24
  hys_value = 3
  判断：25 - 24 = 1 < 3（未超过迟滞值）
  结果：保持档位1（避免抖动）

场景2：当前档位1，温度下降到21°C
  判断：25 - 21 = 4 > 3（超过迟滞值）
  结果：切换到档位0
```

### 4.2 通用补偿算法
```c
int power_get_compensation_value(int raw, const struct common_comp_data *data)
{
    int i;
    int comp_value = raw;

    // 从大到小遍历参考值（温度/电压等）
    for (i = 0; i < data->para_size; i++) {
        if (data->refer >= data->para[i].refer) {
            // raw是原始测量值，减去补偿值得到校正后的值
            comp_value = raw - data->para[i].comp_value;
            break;
        }
    }

    return comp_value;
}
```

**应用示例**：电池电压温度补偿
```c
// 高温下电池内阻降低，电压偏高，需要负补偿
struct compensation_para voltage_temp_comp[] = {
    { 50, 30 },   // 50°C以上，补偿-30mV
    { 30, 10 },   // 30°C以上，补偿-10mV
    { 10, 0 },    // 10°C以上，不补偿
    { -10, -20 }, // -10°C以上，补偿+20mV（低温电压偏低）
};

struct common_comp_data comp_data = {
    .refer = 45,  // 当前温度45°C
    .para_size = 4,
    .para = voltage_temp_comp,
};

int raw_voltage = 4250;  // 测量电压4250mV
int comp_voltage = power_get_compensation_value(raw_voltage, &comp_data);
// 结果：4250 - 10 = 4240mV
```

### 4.3 平滑补偿算法
```c
int power_get_smooth_compensation_value(const struct smooth_comp_data *data)
{
    int current_comp, current_raw, delta_comp, delta_raw;

    current_comp = data->current_comp;  // 当前补偿值
    current_raw = data->current_raw;    // 当前原始值
    delta_comp = current_comp - data->last_comp;  // 补偿值变化
    delta_raw = current_raw - data->last_raw;     // 原始值变化

    // 规则1：补偿值和原始值变化方向相反 → 保持上次补偿值
    if ((delta_comp < 0) && (delta_raw > 0))
        current_comp = data->last_comp;
    else if ((delta_comp > 0) && (delta_raw < 0))
        current_comp = data->last_comp;
    // 规则2：补偿值变化幅度大于原始值 → 限制为原始值变化量
    else if (abs(delta_comp) > abs(delta_raw))
        current_comp = data->last_comp + delta_raw;

    // 规则3：限制最大变化量
    if (current_comp - data->last_comp > data->max_delta)
        current_comp = data->last_comp + data->max_delta;
    else if (data->last_comp - current_comp > data->max_delta)
        current_comp = data->last_comp - data->max_delta;

    return current_comp;
}
```

**应用场景**：充电电流平滑
```
时刻T0：
  原始值：1000mA
  补偿值：950mA

时刻T1（异常突变）：
  原始值：1050mA（上升50mA）
  补偿值：800mA（下降150mA）← 异常
  
  检测到方向相反 → 使用上次补偿值950mA
```

### 4.4 ADC地线补偿算法
```c
int power_get_adc_compensation_value(int adc_value, const struct adc_comp_data *data)
{
    s64 tmp;
    int v_adc;
    int r_ntc;

    // 步骤1：将ADC数字值转换为电压
    // 公式：v_adc = adc_value * adc_v_ref / 2^adc_accuracy
    tmp = (s64)(data->adc_v_ref) * (s64)adc_value * 100000;
    tmp = div_s64(tmp, BIT(data->adc_accuracy));
    v_adc = div_s64(tmp, 100000);
    
    if (data->v_pullup - v_adc == 0)
        return -EPERM;

    // 步骤2：根据分压公式计算NTC电阻
    // 公式：v_adc / (r_ntc + r_comp) = (v_pullup - v_adc) / r_pullup
    // 推导：r_ntc = v_adc * r_pullup / (v_pullup - v_adc) - r_comp
    r_ntc = v_adc * data->r_pullup / (data->v_pullup - v_adc) - data->r_comp;

    return r_ntc;
}
```

**实际电路案例**：NTC温度传感器
```
电路：
  3.3V
   │
  10kΩ (R_pullup)
   │
   ├──> ADC测量 (v_adc)
   │
  NTC电阻 (随温度变化)
   │
  50Ω (R_comp，地线电阻)
   │
  GND

示例计算：
  ADC配置：12bit, Vref=1.8V
  测量值：adc_value = 2048
  
  v_adc = 2048 * 1800 / 4096 = 900mV
  r_ntc = 900 * 10000 / (3300 - 900) - 50
        = 9000000 / 2400 - 50
        = 3750 - 50
        = 3700Ω
  
  查NTC阻值-温度表 → 3700Ω对应25°C
```

### 4.5 线性插值查表算法
```c
int power_lookup_table_linear_trans_dichotomy(const int table[][2], int len, 
                                               int ref, int dir)
{
    // dir=0: table[i][0] -> table[i][1]
    // dir=1: table[i][1] -> table[i][0]
    
    // 判断表格是升序还是降序
    if (table[0][dir] < table[len - 1][dir])
        ret = power_lookup_table_linear_trans_dichotomy_ascending(...);
    else
        ret = power_lookup_table_linear_trans_dichotomy_descending(...);

    return ret;
}

// 升序表的二分查找+线性插值
static int power_lookup_table_linear_trans_dichotomy_ascending(...)
{
    int i = power_lower_bound(table, len, ref, dir);  // 二分查找
    
    if (i < 0)
        return table[len - 1][1 - dir];  // 超出范围返回最后值
    if (table[i][dir] == ref)
        return table[i][1 - dir];         // 精确匹配
    if (i == 0)
        return table[0][1 - dir];         // 小于最小值
    
    // 线性插值
    tmp = (s64)(ref - table[i - 1][dir]) * 
          (s64)(table[i][1 - dir] - table[i - 1][1 - dir]);
    ret = div_s64(tmp, (table[i][dir] - table[i - 1][dir]));
    ret += table[i - 1][1 - dir];
    
    return ret;
}
```

**应用示例**：NTC电阻-温度转换
```c
// NTC阻值-温度对照表（电阻单位Ω，温度单位°C）
int ntc_table[][2] = {
    { 10000, 25 },   // 10kΩ对应25°C
    { 8057,  30 },   // 8.057kΩ对应30°C
    { 6531,  35 },   // 6.531kΩ对应35°C
    { 5327,  40 },   // 5.327kΩ对应40°C
    { 4369,  45 },   // 4.369kΩ对应45°C
};

// 测量到电阻7000Ω，求温度
int r_ntc = 7000;
int temp = power_lookup_table_linear_trans_dichotomy(ntc_table, 5, r_ntc, 0);

// 计算过程：
// 7000介于8057和6531之间
// 线性插值：temp = 30 + (7000-8057)/(6531-8057) * (35-30)
//                = 30 + (-1057)/(-1526) * 5
//                = 30 + 3.46
//                ≈ 33°C
```

### 4.6 混合算法
```c
int power_get_mixed_value(int value0, int value1, const struct legal_range *range)
{
    int mixed;
    int high = value0 > value1 ? value0 : value1;
    int low = value0 > value1 ? value1 : value0;

    // 情况1：两个值都超出合法区间（一个太高，一个太低）
    if ((low < range->low) && (high > range->high))
        // 选择距离合法区间较近的值
        mixed = ((range->low - low) > (high - range->high)) ? low : high;
    
    // 情况2：两个值都在合法区间内
    else if ((low > range->low) && (high < range->high))
        mixed = (high + low) / 2;  // 取平均值
    
    // 情况3：低值在区间内
    else if (low > range->low)
        mixed = high;
    
    // 情况4：高值在区间内
    else
        mixed = low;

    return mixed;
}
```

**应用场景**：双传感器融合
```c
// 电池有两个温度传感器
int temp1 = 42;  // 传感器1
int temp2 = 38;  // 传感器2

struct legal_range temp_range = {
    .low = 0,    // 最低温度0°C
    .high = 60,  // 最高温度60°C
};

int final_temp = power_get_mixed_value(temp1, temp2, &temp_range);
// 两个值都在0-60°C内，取平均值：(42+38)/2 = 40°C
```

### 4.7 轻量级正则表达式匹配
```c
bool power_regex_lite_is_matched(const char *pattern, const char *str)
{
    // 支持的语法：
    // [a-z]    : 匹配a到z任意字符
    // {n}      : 匹配n次
    // |        : 或操作
    
    // 示例：
    // "[a-z]{2}[a-b]{1}" 匹配 "abc"  → true
    // "[0-9]{3}"         匹配 "123"  → true
    // "[a-c]|[x-z]"      匹配 "b"    → true
}
```

**应用场景**：型号字符串验证
```c
// 验证电池型号是否合法
const char *battery_model = "HB123";
bool valid = power_regex_lite_is_matched("[A-Z]{2}[0-9]{3}", battery_model);
// 结果：true（匹配2个大写字母+3个数字）
```

---

## 5. 数学工具函数

### 5.1 统计函数
```c
// 求最小值
int power_get_min_value(const int *data, int size);

// 求最大值
int power_get_max_value(const int *data, int size);

// 求平均值
int power_get_average_value(const int *data, int size);

// 使用示例
int temps[5] = { 35, 42, 38, 40, 36 };
int min_temp = power_get_min_value(temps, 5);  // 35
int max_temp = power_get_max_value(temps, 5);  // 42
int avg_temp = power_get_average_value(temps, 5);  // 38
```

### 5.2 正负数处理
```c
// 返回两个正数中较小的（都非正返回0）
int power_min_positive(int x, int y);
// 示例：power_min_positive(10, 20) = 10
//      power_min_positive(-5, 10) = 10
//      power_min_positive(-5, -3) = 0

// 返回两个正数中较大的（都非正返回0）
int power_max_positive(int x, int y);
// 示例：power_max_positive(10, 20) = 20
//      power_max_positive(-5, 10) = 10
//      power_max_positive(-5, -3) = 0
```

**应用场景**：充电电流限制
```c
int thermal_limit = 2000;  // 温控限流2A
int system_limit = 1500;   // 系统限流1.5A

// 取两个限流值中较小的正值
int final_limit = power_min_positive(thermal_limit, system_limit);
// 结果：1500mA
```

### 5.3 线性插值
```c
int power_linear_interpolate(int y0, int x0, int y1, int x1, int x)
{
    // 公式：y = y0 + (y1 - y0) * (x - x0) / (x1 - x0)
    
    if ((y0 == y1) || (x == x0))
        return y0;
    if ((x1 == x0) || (x == x1))
        return y1;
    
    return y0 + ((y1 - y0) * (x - x0) / (x1 - x0));
}
```

**应用示例**：电压-容量曲线
```c
// 已知：4.2V时容量100%，3.8V时容量20%
// 求：  4.0V时容量？

int capacity = power_linear_interpolate(
    100, 4200,  // (x0, y0): 4.2V → 100%
    20,  3800,  // (x1, y1): 3.8V → 20%
    4000        // x: 4.0V
);

// 计算：capacity = 100 + (20-100)*(4000-4200)/(3800-4200)
//               = 100 + (-80)*(-200)/(-400)
//               = 100 - 40
//               = 60%
```

### 5.4 向上取整
```c
int power_ceil(int dividend, int divisor)
{
    if (divisor == 0)
        return 0;
    
    return dividend / divisor + (dividend % divisor > 0 ? 1 : 0);
}

// 示例
power_ceil(10, 3) = 4   // 10/3 = 3余1 → 向上取整4
power_ceil(9, 3) = 3    // 9/3 = 3余0 → 不需要向上
power_ceil(11, 5) = 3   // 11/5 = 2余1 → 向上取整3
```

---

## 6. 典型使用场景

### 6.1 场景1：温控档位切换（迟滞算法）
```c
// 定义温控档位表
struct hysteresis_para thermal_table[] = {
    { .refer_lth = 0,  .refer_hth = 30, .hys_value = 5 },  // 档位0
    { .refer_lth = 30, .refer_hth = 45, .hys_value = 3 },  // 档位1
    { .refer_lth = 45, .refer_hth = 60, .hys_value = 2 },  // 档位2
};

struct common_hys_data hys_data = {
    .refer = 0,  // 动态更新当前温度
    .para_size = 3,
    .para = thermal_table,
};

// 温控逻辑
static int current_level = 0;

void thermal_control_update(int temp)
{
    hys_data.refer = temp;
    current_level = power_get_hysteresis_index(current_level, &hys_data);
    
    // 根据档位设置充电电流
    switch (current_level) {
    case 0:
        set_charge_current(3000);  // 3A
        break;
    case 1:
        set_charge_current(2000);  // 2A
        break;
    case 2:
        set_charge_current(1000);  // 1A
        break;
    }
}

// 温度变化过程：
// 25°C → current_level=0 → 3A充电
// 升温到32°C → 切换到level=1 → 2A充电
// 降温到29°C → 保持level=1（未超过迟滞值3°C）
// 降温到26°C → 切换到level=0（30-26=4>3）
```

### 6.2 场景2：电池电压温度补偿
```c
// 温度补偿表（温度越高，测量电压越高）
struct compensation_para voltage_comp_table[] = {
    { .refer = 60, .comp_value = 50 },   // 60°C以上，补偿-50mV
    { .refer = 40, .comp_value = 30 },   // 40°C以上，补偿-30mV
    { .refer = 20, .comp_value = 10 },   // 20°C以上，补偿-10mV
    { .refer = 0,  .comp_value = 0 },    // 0°C以上，不补偿
    { .refer = -20,.comp_value = -30 },  // -20°C以上，补偿+30mV
};

int get_compensated_voltage(int raw_voltage, int temp)
{
    struct common_comp_data comp_data = {
        .refer = temp,
        .para_size = 5,
        .para = voltage_comp_table,
    };
    
    return power_get_compensation_value(raw_voltage, &comp_data);
}

// 使用
int raw_volt = 4250;   // 测量电压4250mV
int temp = 45;         // 当前温度45°C
int real_volt = get_compensated_voltage(raw_volt, temp);
// 结果：4250 - 30 = 4220mV
```

### 6.3 场景3：NTC温度传感器读取
```c
// ADC配置
struct adc_comp_data ntc_adc_config = {
    .adc_accuracy = 12,       // 12位ADC
    .adc_v_ref = 1800,        // 参考电压1.8V
    .v_pullup = 3300,         // 上拉电压3.3V
    .r_pullup = 10000,        // 上拉电阻10kΩ
    .r_comp = 50,             // 地线电阻50Ω
};

// NTC阻值-温度表
int ntc_r_to_t_table[][2] = {
    { 27280, 0 },
    { 15462, 10 },
    { 10000, 25 },
    { 6531,  35 },
    { 4369,  45 },
    { 3000,  55 },
};

int get_ntc_temperature(int adc_value)
{
    int r_ntc, temp;
    
    // 步骤1：ADC值转换为NTC电阻
    r_ntc = power_get_adc_compensation_value(adc_value, &ntc_adc_config);
    if (r_ntc < 0) {
        hwlog_err("adc conversion failed\n");
        return 25;  // 返回默认温度
    }
    
    // 步骤2：查表转换为温度（带线性插值）
    temp = power_lookup_table_linear_trans_dichotomy(
        ntc_r_to_t_table, 6, r_ntc, 0);
    
    return temp;
}

// 测试
int adc = 2048;  // ADC读数
int temp = get_ntc_temperature(adc);
// 输出：约25°C
```

### 6.4 场景4：充电电流平滑
```c
static struct smooth_comp_data current_smooth = {
    .current_comp = 0,
    .current_raw = 0,
    .last_comp = 0,
    .last_raw = 0,
    .max_delta = 200,  // 最大变化200mA
};

int get_smooth_charge_current(int raw_current, int comp_current)
{
    int final_current;
    
    // 更新数据
    current_smooth.current_raw = raw_current;
    current_smooth.current_comp = comp_current;
    
    // 获取平滑值
    final_current = power_get_smooth_compensation_value(&current_smooth);
    
    // 保存为上次值
    current_smooth.last_raw = raw_current;
    current_smooth.last_comp = final_current;
    
    return final_current;
}

// 使用场景
// T0: raw=1000, comp=950 → 输出950
// T1: raw=1050, comp=800（异常） → 检测到方向相反 → 输出950
// T2: raw=1100, comp=1050 → 变化50/100正常 → 输出1050
```

### 6.5 场景5：双温度传感器融合
```c
int get_battery_temp_fused(void)
{
    int temp1, temp2;
    struct legal_range temp_range = {
        .low = 0,
        .high = 60,
    };
    
    temp1 = read_ntc_sensor_1();  // 电池顶部
    temp2 = read_ntc_sensor_2();  // 电池底部
    
    // 混合两个传感器值
    return power_get_mixed_value(temp1, temp2, &temp_range);
}

// 场景：
// temp1=42°C, temp2=38°C → 都在0-60内 → (42+38)/2 = 40°C
// temp1=-5°C, temp2=35°C → temp1异常 → 选择35°C
// temp1=25°C, temp2=70°C → temp2异常 → 选择25°C
```

---

## 7. 调试方法

### 7.1 启用详细日志
```c
// 所有算法函数都内置了hwlog_info日志
// 通过动态日志等级控制

// 启用power_algo日志
echo 8 > /proc/sys/kernel/printk  // 提升内核日志等级
dmesg -w | grep "power_algo"

// 典型日志输出
[  123.456] power_algo: new_index:1, refer:32, lth:30, hth:45, hys:3
[  123.457] power_algo: refer:32, without_comp:4250, with_comp:4220
[  123.458] power_algo: v_adc:900, r_pullup:10000, r_ntc:3700
```

### 7.2 单元测试框架
```c
// 迟滞算法测试
void test_hysteresis_algorithm(void)
{
    struct hysteresis_para test_para[] = {
        { 0, 30, 5 },
        { 30, 45, 3 },
    };
    
    struct common_hys_data test_data = {
        .refer = 32,
        .para_size = 2,
        .para = test_para,
    };
    
    int index;
    
    // 测试1：从档位0升到档位1
    index = power_get_hysteresis_index(0, &test_data);
    pr_info("Test1: index=%d (expect 1)\n", index);
    
    // 测试2：档位1温度降到29°C，应保持
    test_data.refer = 29;
    index = power_get_hysteresis_index(1, &test_data);
    pr_info("Test2: index=%d (expect 1)\n", index);
    
    // 测试3：档位1温度降到26°C，应切换
    test_data.refer = 26;
    index = power_get_hysteresis_index(1, &test_data);
    pr_info("Test3: index=%d (expect 0)\n", index);
}
```

### 7.3 常见问题排查

| 问题现象 | 可能原因 | 排查方法 |
|---------|---------|---------|
| 温控档位频繁切换 | 迟滞值设置太小 | 增大hys_value，检查日志中的refer和lth/hth |
| 补偿后数值异常 | 补偿表顺序错误 | 确保para表按refer从大到小排列 |
| ADC转换返回负值 | v_pullup <= v_adc | 检查电路连接，v_pullup必须大于v_adc |
| 查表结果不准确 | 表格未按顺序排列 | 确保table[][dir]列为升序或降序 |
| 平滑算法不生效 | 未保存last值 | 每次调用后更新last_comp和last_raw |

---

## 8. 与其他模块的交互

### 8.1 依赖关系
```
power_algorithm 模块依赖：
├── Linux标准库
│   ├── linux/math64.h    --> 64位除法
│   ├── linux/ctype.h     --> 字符类型判断
│   └── linux/bitops.h    --> 位操作（BIT宏）
├── securec.h             --> 安全字符串函数
└── power_printk.h        --> 日志打印

无其他电源模块依赖 → 纯算法库，可独立使用
```

### 8.2 被依赖关系（几乎所有电源模块）

| 模块 | 使用的算法 | 典型场景 |
|-----|-----------|---------|
| **coul驱动** | 线性插值、查表转换 | 电压-容量转换、温度读取 |
| **charger驱动** | 迟滞算法、补偿算法 | 温控档位切换、电流补偿 |
| **battery_temp** | ADC补偿、查表转换 | NTC温度传感器读取 |
| **direct_charge** | 平滑补偿、混合算法 | 直充电流平滑、双路融合 |
| **wireless_charge** | 统计函数、补偿算法 | 功率计算、温度补偿 |

### 8.3 实际调用示例
```c
// 在coul_core.c中使用查表算法
#include <chipset_common/hwpower/common_module/power_algorithm.h>

int coul_convert_voltage_to_capacity(int voltage)
{
    // 电压-容量对照表
    static const int volt_cap_table[][2] = {
        { 4200, 100 },
        { 4100, 90 },
        { 4000, 70 },
        { 3900, 50 },
        { 3800, 30 },
        { 3700, 10 },
        { 3500, 0 },
    };
    
    return power_lookup_table_linear_trans_dichotomy(
        volt_cap_table, 7, voltage, 0);
}

// 在charger.c中使用迟滞算法
static int g_thermal_level = 0;

void charger_thermal_control(int temp)
{
    static struct hysteresis_para thermal_para[] = {
        { 0, 35, 5 },
        { 35, 45, 3 },
        { 45, 60, 2 },
    };
    
    struct common_hys_data hys_data = {
        .refer = temp,
        .para_size = 3,
        .para = thermal_para,
    };
    
    g_thermal_level = power_get_hysteresis_index(g_thermal_level, &hys_data);
}
```

---

## 9. 性能优化建议

### 9.1 避免重复计算
```c
// 不推荐：每次都查表
int get_temp_from_adc(int adc)
{
    int r_ntc = power_get_adc_compensation_value(adc, &adc_config);
    return power_lookup_table_linear_trans_dichotomy(ntc_table, 10, r_ntc, 0);
}

void update_loop(void)
{
    for (i = 0; i < 100; i++) {
        int temp = get_temp_from_adc(read_adc());  // 频繁查表
        // ...
    }
}

// 推荐：缓存结果
static int g_cached_temp;
static unsigned long g_cache_time;

int get_temp_from_adc_cached(int adc)
{
    if (time_before(jiffies, g_cache_time + HZ / 10))  // 100ms缓存
        return g_cached_temp;
    
    g_cached_temp = get_temp_from_adc(adc);
    g_cache_time = jiffies;
    return g_cached_temp;
}
```

### 9.2 优化查表算法
```c
// 对于频繁查询的小表，使用线性查找可能更快
// 二分查找适合大表（>20项）

// 小表（<10项）推荐线性查找
int lookup_small_table(int value)
{
    int i;
    for (i = 0; i < table_size - 1; i++) {
        if (value >= table[i][0] && value < table[i+1][0])
            return linear_interpolate(...);
    }
    return table[table_size-1][1];
}
```

---

## 10. 最佳实践建议

### 10.1 迟滞算法使用建议
```c
// 1. 合理设置迟滞值
//    - 温度：3-5°C
//    - 电压：50-100mV
//    - 电流：100-200mA

// 2. 档位边界留有余量
struct hysteresis_para good_example[] = {
    { 0, 28, 5 },   // 留2°C余量(30-28)
    { 30, 43, 3 },  // 留2°C余量(45-43)
    { 45, 60, 2 },
};

// 不推荐：边界无余量
struct hysteresis_para bad_example[] = {
    { 0, 30, 5 },   // 边界重合
    { 30, 45, 3 },  // 可能导致抖动
    { 45, 60, 2 },
};
```

### 10.2 补偿算法使用建议
```c
// 1. 补偿表必须从大到小排列
struct compensation_para correct[] = {
    { 60, 50 },  // ✓ 降序排列
    { 40, 30 },
    { 20, 10 },
};

struct compensation_para wrong[] = {
    { 20, 10 },  // ✗ 升序会导致匹配错误
    { 40, 30 },
    { 60, 50 },
};

// 2. 补偿值应基于实测数据校准
void calibrate_compensation_table(void)
{
    // 在不同温度下测量实际值与标准值的差异
    // 温度 | 标准值 | 实测值 | 补偿值
    //  60  |  4200  |  4250  |   50
    //  40  |  4200  |  4230  |   30
    //  20  |  4200  |  4210  |   10
}
```

### 10.3 查表算法使用建议
```c
// 1. 确保表格单调性
int good_table[][2] = {
    { 10000, 25 },  // 电阻递减，温度递增
    { 8057,  30 },  // ✓ 单调
    { 6531,  35 },
};

int bad_table[][2] = {
    { 10000, 25 },
    { 6531,  35 },  // ✗ 跳过了中间值
    { 8057,  30 },  // 破坏单调性
};

// 2. 表格范围覆盖工作区间
// 如果工作温度0-60°C，表格应覆盖-10到70°C
```

---

## 11. 总结

### 11.1 核心特性
| 特性 | 说明 |
|-----|------|
| **通用性强** | 与硬件无关，纯算法实现 |
| **场景丰富** | 覆盖补偿、迟滞、滤波、转换等 |
| **高效实现** | 使用二分查找、64位除法优化 |
| **日志完善** | 所有函数内置调试日志 |
| **易于集成** | 无外部依赖，可独立编译 |

### 11.2 算法总览
```
15个核心算法函数：
├── 补偿类（3个）
│   ├── power_get_compensation_value          - 通用补偿
│   ├── power_get_smooth_compensation_value   - 平滑补偿
│   └── power_get_adc_compensation_value      - ADC地线补偿
├── 迟滞类（1个）
│   └── power_get_hysteresis_index            - 防抖动迟滞
├── 转换类（2个）
│   ├── power_lookup_table_linear_trans_dichotomy  - 查表+插值
│   └── power_convert_value                   - 数值映射
├── 统计类（3个）
│   ├── power_get_min_value                   - 最小值
│   ├── power_get_max_value                   - 最大值
│   └── power_get_average_value               - 平均值
├── 数学类（6个）
│   ├── power_linear_interpolate              - 线性插值
│   ├── power_min_positive                    - 最小正数
│   ├── power_max_positive                    - 最大正数
│   ├── power_get_mixed_value                 - 混合算法
│   ├── power_ceil                            - 向上取整
│   └── power_change_char_to_digit            - 字符转数字
└── 字符串类（3个）
    ├── power_sub_str                         - 子串提取
    ├── power_find_first_char                 - 字符查找
    └── power_regex_lite_is_matched           - 轻量正则
```

### 11.3 价值总结
**power_algorithm作为电源管理子系统的数学基础库**：
- 提供**标准化的数据处理算法**，避免各模块重复实现
- 实现**高质量的补偿和滤波**，提升测量精度
- 通过**迟滞算法**减少系统抖动，提升稳定性
- 作为**纯算法层**，完全独立于硬件，便于移植和测试
