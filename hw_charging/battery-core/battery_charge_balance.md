---
outline: deep
---

# 华为电池核心之battery_charge_balance 模块

## 一、模块概述

`battery_charge_balance` 模块是华为电源管理子系统中的**双电池充电平衡驱动**，专门用于**多电池充电电流智能分配**场景。该模块根据双电池的温度、电压、电流状态，通过 CC/CV 曲线查表和智能平衡算法，动态计算每个电池的最优充电电流，确保双电池充电安全性和一致性。

**核心功能：**
- 支持**并联模式**（BAT_PARALLEL_MODE）和**串联模式**（BAT_SERIAL_MODE）
- 多维度 CC/CV 曲线管理（温度-电压-电流三维表）
- 双电池充电电流动态平衡算法
- 电流偏差检测与 DSM 故障报告
- 电池缺失检测与容错处理
- Power log 日志记录功能

**架构图：**

```
┌─────────────────────────────────────────────────┐
│         bat_chg_balance_get_cur_info()          │
│            (External Interface)                  │
└────────────────┬────────────────────────────────┘
                 │
          ┌──────┴──────┐
          │  Mode Check  │
          └──────┬──────┘
                 │
      ┌──────────┴──────────┐
      │                     │
┌─────▼─────┐        ┌─────▼─────┐
│ Parallel  │        │  Serial   │
│   Mode    │        │   Mode    │
└─────┬─────┘        └─────┬─────┘
      │                     │
      │  Current Balance    │  Min Current
      │  Algorithm          │  Selection
      │                     │
└─────┴─────────────────────┴─────┘
              │
        ┌─────▼─────┐
        │  CC/CV    │
        │  Lookup   │
        └───────────┘
```

## 二、主要数据结构

### 2.1 CC/CV 节点 `bat_cccv_node`

```c
struct bat_cccv_node {
    int vol;  // 电压阈值（mV）
    int cur;  // 对应电流限制（mA）
};
```

**说明：** 定义 CC/CV 充电曲线的一个采样点，电压达到 `vol` 时，充电电流限制为 `cur`。

### 2.2 电池充电信息 `bat_chg_balance_info`

```c
struct bat_chg_balance_info {
    int temp;  // 电池温度（0.1°C）
    int vol;   // 电池电压（mV）
    int cur;   // 电池电流（mA）
};
```

**用途：** 传递单个电池的实时状态给平衡算法。

### 2.3 充电平衡结果 `bat_chg_balance_cur`

```c
struct bat_chg_balance_cur {
    int total_cur;                          // 总充电电流（mA）
    struct bat_cccv_node cccv[BAT_BALANCE_COUNT];  // 每个电池的 CC/CV 节点
};
```

### 2.4 温度-CC/CV 映射表 `bat_temp_cccv`

```c
struct bat_temp_cccv {
    int temp;                                // 温度阈值（0.1°C）
    int len;                                 // CC/CV 表长度
    struct bat_cccv_node cccv_tab[BAL_CCCV_TAB_LEN];  // CC/CV 曲线表
};
```

**说明：** 一个温度区间对应一条 CC/CV 充电曲线。

### 2.5 电池参数表 `bat_param`

```c
struct bat_param {
    u32 weight;                              // 电池容量权重（mAh）
    int len;                                 // 温度表长度
    struct bat_temp_cccv temp_tab[BAL_TEMP_TAB_LEN];  // 温度-CC/CV 映射表
};
```

### 2.6 主设备结构体 `bat_chg_bal_device`

```c
struct bat_chg_bal_device {
    struct device *dev;
    struct bat_param param_tab[BAT_BALANCE_COUNT];  // 双电池参数表
    int unbalance_th[BAL_UNBAL_TAB_LEN];            // 电流不平衡阈值（比例）
    int req_cur[BAT_BALANCE_COUNT];                 // 请求电流记录
    int bal_cur;                                    // 平衡后总电流
    int ratio_err_cnt;                              // 比例错误计数器
    int detect_cycle;                               // 检测周期计数器
};
```

---

## 三、核心算法

### 3.1 CC/CV 查表算法 `bat_chg_bal_get_cccv_node()`

**查表流程：**

```c
输入：bat_id（电池编号）、info（温度/电压/电流）
输出：cccv_node（对应的 CC/CV 节点）

步骤：
1. 根据温度查找 temp_tab[] 中对应的温度区间（二分查找）
   → 找到 temp_cccv 结构
   
2. 根据电压在 cccv_tab[] 中查找对应的电压区间
   → 找到 bat_cccv_node
   
3. 返回该节点的电压阈值和电流限制
```

**示例：**

| 温度范围 | CC/CV 曲线 |
|---------|-----------|
| temp < 150 (15°C) | cccv_tab_0: [(3000mV, 1000mA), (4000mV, 500mA), ...] |
| 150 ≤ temp < 250 (25°C) | cccv_tab_1: [(3000mV, 2000mA), (4000mV, 1000mA), ...] |
| temp ≥ 250 | cccv_tab_2: [(3000mV, 1500mA), (4000mV, 800mA), ...] |

### 3.2 并联模式平衡算法 `bat_chg_bal_parallel_get_cur_info()`

**算法核心：动态电流分配确保双电池同步充电**

#### 3.2.1 电池缺失检测

```c
if (!is_exist[BAT_MAIN] && !is_exist[BAT_AUX])
    total_cur = cccv_main.cur + cccv_aux.cur  // 双电池缺失，不平衡
else if (!is_exist[BAT_MAIN])
    total_cur = cccv_aux.cur                   // 主电池缺失，仅充辅助
else if (!is_exist[BAT_AUX])
    total_cur = cccv_main.cur                  // 辅助电池缺失，仅充主电池
```

#### 3.2.2 电流请求计算 `bat_chg_bal_parallel_requst_current()`

**公式推导：**

对于主电池：
```c
若 cur_main > 0:
    own_cur_main = cccv_main.cur
    delta = cccv_main.cur - cur_main  // 电流偏差
    
    若 cur_aux > 0:
        other_cur_main = cur_aux + delta × cur_aux / cur_main
        // 按比例分配电流偏差给辅助电池
    否则:
        other_cur_main = 0
否则:
    own_cur_main = cccv_main.cur
    other_cur_main = cccv_aux.cur
```

**意义：** 当主电池 CC/CV 限制提高时，按当前电流比例增加辅助电池的电流请求，确保双电池同步到达满电。

#### 3.2.3 最终电流裁决

```c
request_cur[BAT_MAIN] = min(own_cur[BAT_MAIN], other_cur[BAT_AUX])
request_cur[BAT_AUX] = min(own_cur[BAT_AUX], other_cur[BAT_MAIN])

total_cur = request_cur[BAT_MAIN] + request_cur[BAT_AUX]
```

**示例计算：**

| 参数 | 值 |
|------|---|
| cccv_main.cur | 2000mA |
| cccv_aux.cur | 1800mA |
| cur_main（当前） | 1500mA |
| cur_aux（当前） | 1350mA |

计算过程：
```
主电池请求：
  delta_main = 2000 - 1500 = 500mA
  other_cur_main = 1350 + 500 × 1350 / 1500 = 1800mA
  
辅助电池请求：
  delta_aux = 1800 - 1350 = 450mA
  other_cur_aux = 1500 + 450 × 1500 / 1350 = 2000mA
  
最终电流：
  request_cur[MAIN] = min(2000, 1800) = 1800mA
  request_cur[AUX] = min(1800, 2000) = 1800mA
  total_cur = 1800 + 1800 = 3600mA
```

#### 3.2.4 电流偏差检测 `bat_chg_bal_parallel_current_bias_detect_dmd()`

**检测逻辑：**

```c
cur_ratio = cur_main × 1000 / cur_aux  // 计算电流比例

if (total_cur < 5600mA)
    复位检测计数器  // 小电流不检测
    
if (cur_ratio < unbalance_th[0] || cur_ratio > unbalance_th[1])
    ratio_err_cnt++
    
    if (ratio_err_cnt == 3)  // 连续3次超限
        触发 DMD 报告：POWER_DSM_DUAL_BATTERY_CURRENT_BIAS_DETECT
        
每经过 5 个检测周期复位计数器
```

**DTS 配置示例：**
```
unbalance_th = <800 1200>;  // 允许电流比例 0.8 ~ 1.2
```

### 3.3 串联模式算法 `bat_chg_bal_serial_get_cur_info()`

**算法逻辑：取最小电流**

```c
total_cur = min(cccv_main.cur, cccv_aux.cur) × 2
```

**说明：** 串联模式下双电池流过相同电流，因此选择较小的 CC/CV 限制，乘以 2 是因为串联电压加倍但系统视角电流不变。

---

## 四、DTS 配置

### 4.1 配置示例

```
battery_charge_balance {
    compatible = "huawei,battery_charge_balance";
    
    /* 电流不平衡检测阈值 */
    unbalance_th = <800 1200>;  // 比例范围 [0.8, 1.2]
    
    /* 主电池配置 */
    battery0 {
        weight = <2500>;  // 容量 2500mAh
        
        /* 温度-CC/CV 映射表 */
        temp_tab = 
            "0" "cccv_0c",      // 0°C → cccv_0c 表
            "150" "cccv_15c",   // 15°C → cccv_15c 表
            "450" "cccv_45c";   // 45°C → cccv_45c 表
        
        /* 0°C 的 CC/CV 曲线 */
        cccv_0c = <
            3000 1000    // 3000mV → 1000mA
            3500 800
            4000 500
            4200 300
            4350 150
        >;
        
        /* 15°C 的 CC/CV 曲线 */
        cccv_15c = <
            3000 2000
            3500 1800
            4000 1000
            4200 500
            4350 200
        >;
        
        /* 45°C 的 CC/CV 曲线 */
        cccv_45c = <
            3000 1500
            3500 1200
            4000 800
            4200 400
            4350 150
        >;
    };
    
    /* 辅助电池配置 */
    battery1 {
        weight = <2500>;
        temp_tab = 
            "0" "cccv_0c_aux",
            "150" "cccv_15c_aux",
            "450" "cccv_45c_aux";
        
        cccv_0c_aux = <
            3000 950
            3500 750
            4000 480
            4200 280
            4350 140
        >;
        
        cccv_15c_aux = <
            3000 1900
            3500 1700
            4000 950
            4200 480
            4350 190
        >;
        
        cccv_45c_aux = <
            3000 1450
            3500 1150
            4000 750
            4200 380
            4350 140
        >;
    };
};
```

### 4.2 DTS 参数说明

| 参数 | 类型 | 说明 |
|------|------|------|
| `unbalance_th[2]` | u32[2] | 电流不平衡阈值，格式：[下限, 上限]（千分比） |
| `weight` | u32 | 电池容量权重（mAh），用于多电池容量加权计算 |
| `temp_tab` | string[] | 温度-CC/CV 表映射，格式：["温度1" "表名1" "温度2" "表名2" ...] |
| `cccv_xxx` | u32[] | CC/CV 曲线，格式：[vol1 cur1 vol2 cur2 ...]（mV, mA） |

---

## 五、外部接口

### 5.1 主接口 `bat_chg_balance_get_cur_info()`

```c
int bat_chg_balance_get_cur_info(
    struct bat_chg_balance_info *info,  // 输入：双电池状态数组
    u32 info_len,                        // 输入：数组长度（必须为 2）
    struct bat_chg_balance_cur *result,  // 输出：平衡后的电流信息
    int mode                             // 输入：BAT_PARALLEL_MODE 或 BAT_SERIAL_MODE
)
```

**调用流程：**

```
1. 调用 bat_chg_bal_get_cccv_node() 获取双电池的 CC/CV 节点
2. 根据 mode 调用对应的平衡算法：
   - BAT_PARALLEL_MODE → bat_chg_bal_parallel_get_cur_info()
   - BAT_SERIAL_MODE → bat_chg_bal_serial_get_cur_info()
3. 返回 total_cur 和 cccv[] 数组
```

**使用示例：**

```c
struct bat_chg_balance_info info[2];
struct bat_chg_balance_cur result;

// 填充双电池状态
info[BAT_MAIN].temp = 250;   // 25°C
info[BAT_MAIN].vol = 3800;   // 3800mV
info[BAT_MAIN].cur = 1500;   // 1500mA

info[BAT_AUX].temp = 240;    // 24°C
info[BAT_AUX].vol = 3750;    // 3750mV
info[BAT_AUX].cur = 1400;    // 1400mA

// 获取平衡电流
bat_chg_balance_get_cur_info(info, 2, &result, BAT_PARALLEL_MODE);

// 结果：
// result.total_cur = 平衡后的总电流（mA）
// result.cccv[BAT_MAIN] = 主电池的 CC/CV 节点
// result.cccv[BAT_AUX] = 辅助电池的 CC/CV 节点
```

---

## 六、Power Log 日志系统

### 6.1 日志注册

```c
static struct power_log_ops bat_chg_bal_log_ops = {
    .dev_name = "bat_balance",
    .dump_log_head = bat_chg_bal_get_log_head,
    .dump_log_content = bat_chg_bal_dump_log_data,
};

// probe 中注册
power_log_ops_register(&bat_chg_bal_log_ops);
```

### 6.2 日志格式

**表头：**
```
bal_cur  req_cur0 req_cur1
```

**数据示例：**
```
3600     1800     1800
```

**说明：**
- `bal_cur`: 平衡后总电流（mA）
- `req_cur0`: 主电池请求电流（mA）
- `req_cur1`: 辅助电池请求电流（mA）

---

## 七、DMD 故障报告

### 报告事件

| DMD 错误码 | 触发条件 | 内容 |
|-----------|---------|------|
| POWER_DSM_DUAL_BATTERY_CURRENT_BIAS_DETECT | 双电池电流比例超出阈值 3 次 | 包含双电池的 cur/vol/temp 和 cur_ratio |

### 7.1 DMD 消息示例

```
cur_ratio out range, cur vol temp info: 
main-1800, 3850, 245, 
aux-1200, 3820, 242 
cur_ratio: 1500 
ratio_range:800 1200
```

**解读：**
- 主电池电流 1800mA，辅助电池 1200mA
- 电流比例 1.5（1500/1000），超出阈值 [0.8, 1.2]
- 可能原因：电池老化不一致、温度差异导致内阻不同

---

## 十、驱动生命周期

### 10.1 初始化流程 `bat_chg_bal_probe()`

```
1. 分配设备结构体：devm_kzalloc()
2. 解析 DTS 配置：bat_chg_bal_parse_dts()
   ├─ 读取 unbalance_th
   ├─ 解析 battery0 节点（主电池）
   │  ├─ 读取 weight
   │  ├─ 读取 temp_tab
   │  └─ 逐条读取 CC/CV 曲线表
   └─ 解析 battery1 节点（辅助电池）
3. 注册全局设备：g_bat_chg_bal_dev = di
4. 注册 power_log 日志系统
```

### 10.2 DTS 解析细节

**温度表解析：**
```c
temp_tab = "150" "cccv_15c" "450" "cccv_45c"

解析结果：
  temp_tab[0].temp = 150  (15°C)
  temp_tab[0].cccv_tab 从 "cccv_15c" 属性读取
  temp_tab[1].temp = 450  (45°C)
  temp_tab[1].cccv_tab 从 "cccv_45c" 属性读取
```

**CC/CV 表解析：**
```c
cccv_15c = <3000 2000 4000 1000 4350 200>

解析结果：
  cccv_tab[0] = {vol: 3000, cur: 2000}
  cccv_tab[1] = {vol: 4000, cur: 1000}
  cccv_tab[2] = {vol: 4350, cur: 200}
```

### 10.3 模块加载优先级

```c
late_initcall_sync(bat_chg_bal_init);
```

**说明：** 使用 `late_initcall_sync` 确保在电池驱动和充电驱动之后加载，避免依赖问题。

---

## 十一、调试技巧

### 11.1 查看实时平衡日志

通过 power_log 系统查看：

```bash
cat /sys/kernel/debug/hwpower/power_log  # 具体路径依系统而定
```

输出示例：
```
bal_cur  req_cur0 req_cur1
3600     1800     1800
3400     1700     1700
```

### 11.2 模拟温度变化测试

修改 battery_charge_balance.c 添加日志：

```c
hwlog_info("bat%d temp=%d, select temp_cccv[%d].temp=%d, vol=%d, select cccv[%d] vol=%d cur=%d\n",
    bat_id, info.temp, temp_idx, temp_cccv->temp,
    info.vol, cccv_idx, node->vol, node->cur);
```

### 11.3 验证平衡算法

在 battery_charge_balance_parallel.c 末尾添加详细日志：

```c
hwlog_info("=== Balance Algorithm ===\n");
hwlog_info("Input: main[%dmA,%dmV,%d°C] aux[%dmA,%dmV,%d°C]\n",
    info[BAT_MAIN].cur, info[BAT_MAIN].vol, info[BAT_MAIN].temp,
    info[BAT_AUX].cur, info[BAT_AUX].vol, info[BAT_AUX].temp);
hwlog_info("CCCV: main[%dmV→%dmA] aux[%dmV→%dmA]\n",
    cccv_node[BAT_MAIN].vol, cccv_node[BAT_MAIN].cur,
    cccv_node[BAT_AUX].vol, cccv_node[BAT_AUX].cur);
hwlog_info("Result: total=%dmA, req_main=%dmA, req_aux=%dmA\n",
    result->total_cur, request_cur[BAT_MAIN], request_cur[BAT_AUX]);
```

### 11.4 监控 DMD 告警

```bash
dmesg | grep "battery_charge_balance"
```

常见日志：
```
battery_charge_balance: cur_ratio out range  # 电流不平衡
battery_charge_balance: battery main not exist  # 主电池缺失
battery_charge_balance: battery aux not exist  # 辅助电池缺失
```

### 11.5 验证 DTS 解析

在 battery_charge_balance.c 末尾添加 dump 代码：

```c
for (bat_id = 0; bat_id < BAT_BALANCE_COUNT; bat_id++) {
    hwlog_info("Battery%d: weight=%u\n", bat_id, di->param_tab[bat_id].weight);
    for (i = 0; i < di->param_tab[bat_id].len; i++) {
        hwlog_info("  temp_tab[%d]: temp=%d, cccv_len=%d\n",
            i, di->param_tab[bat_id].temp_tab[i].temp,
            di->param_tab[bat_id].temp_tab[i].len);
    }
}
```

---

## 十二、关键宏定义

```c
#define BAT_MAIN                0            // 主电池索引
#define BAT_AUX                 1            // 辅助电池索引
#define BAT_BALANCE_COUNT       2            // 电池总数
#define BAL_TEMP_TAB_LEN        10           // 最大温度区间数
#define BAL_CCCV_TAB_LEN        10           // 单条 CC/CV 曲线最大节点数
#define BAL_UNBAL_TAB_LEN       2            // 不平衡阈值数组长度
#define BAL_DETECT_CYCLE        5            // 检测周期
#define BAL_RATIO_ERR_COUNT     3            // 触发 DMD 的错误计数阈值
#define BAL_DETECT_CUR_TH       5600         // 电流检测阈值（mA）
```

---

## 十三、算法流程图

### 13.1 完整调用流程

```
外部充电模块
      │
      ├─ 获取双电池状态（temp, vol, cur）
      │
      ▼
bat_chg_balance_get_cur_info()
      │
      ├─ bat_chg_bal_get_cccv_node(BAT_MAIN)
      │    └─ 查温度表 → 查 CC/CV 表 → 返回 cccv_node_main
      │
      ├─ bat_chg_bal_get_cccv_node(BAT_AUX)
      │    └─ 查温度表 → 查 CC/CV 表 → 返回 cccv_node_aux
      │
      ├─ mode == PARALLEL?
      │    YES ▼
      │    bat_chg_bal_parallel_get_cur_info()
      │         ├─ 电池存在检测
      │         ├─ 电流偏差检测（DMD）
      │         ├─ 双向电流请求计算
      │         ├─ 电流裁决（取最小）
      │         └─ 返回 total_cur
      │
      │    NO ▼
      │    bat_chg_bal_serial_get_cur_info()
      │         ├─ 取 min(cccv_main.cur, cccv_aux.cur)
      │         └─ 返回 total_cur × 2
      │
      ▼
返回 total_cur 给充电控制器
```

---

## 十四、总结

`battery_charge_balance` 模块通过**多温度区间 CC/CV 曲线表**和**智能电流平衡算法**，实现了双电池充电的精细化管理。核心亮点包括：

1. **三维查表机制：** 温度 → CC/CV 表 → 电压/电流限制，适配不同工况
2. **动态平衡算法：** 并联模式下按比例分配电流偏差，确保双电池同步充电
3. **容错设计：** 电池缺失自动降级，电流偏差持续监控并 DMD 上报
4. **灵活配置：** DTS 完全可配置 CC/CV 曲线，支持不同电池规格
5. **调试友好：** power_log 系统实时记录平衡结果，便于问题定位

该模块是华为折叠屏等多电池设备充电系统的核心组件，确保了双电池充电安全性、一致性和最优充电速度。