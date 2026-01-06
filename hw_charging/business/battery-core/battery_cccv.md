---
outline: deep
---
# 华为电池核心之battery_cccv模块

## 一、模块概述

battery_cccv.c 是华为电源管理框架中的**电池恒流恒压（CC/CV）充电曲线管理驱动**，核心功能：

- **多温度分段充电策略** - 根据电池温度选择不同的充电曲线
- **电压-电流映射表** - 提供 VBAT → ICHG 的查询接口
- **动态比例调整** - 支持运行时按比例调整充电电流
- **时间约束充电** - 支持基于充电时长的电流限制
- **电池品牌适配** - 根据电池品牌加载不同的充电参数

---

## 二、核心数据结构

### 1. **充电分段项**

```c
struct bat_cccv {
    int vbat;   // 电池电压 (mV)
    int ichg;   // 充电电流 (mA)
    int time;   // 时间限制 (秒，0 表示无限制)
};
```

**含义**：定义充电曲线中的一个控制点，当电池电压达到 `vbat` 时，应使用 `ichg` 充电电流，且该段可能有时间限制 `time`。

---

### 2. **温度分组表**

```c
struct bat_cccv_tbat {
    int tbat_th;                                 // 温度阈值 (°C * 10)
    int stage_size;                              // 分段数量
    struct bat_cccv cccv[BAT_CCCV_MAX_STAGE];   // 充电分段表 (最多 10 段)
};
```

**含义**：一组温度区间对应的充电曲线。`tbat_th` 是温度上限，当电池温度低于此值时使用该组充电曲线。

---

### 3. **设备结构体**
```c
struct bat_cccv_dev {
    struct device *dev;
    struct notifier_block plugged_nb;            // USB 插拔事件通知
    struct notifier_block chg_nb;                // 充电事件通知
    struct notifier_block wlc_nb;                // 无线充电事件通知
    struct bat_cccv_tbat tbat_cccv_tbl[BAT_CCCV_MAX_TEMP_NUM];  // 温度分组表 (最多 10 组)
    int tbat_cccv_tbl_group_size;                // 实际温度分组数量
    struct bat_cccv *cccv_with_ratio_tbl;        // 动态生成的比例调整后表
    int cccv_with_ratio_tbl_size;                // 动态表大小
    u32 first_start_time;                        // 首次充电开始时间戳 (秒)
    int last_vbat;                               // 上次查询的电池电压 (用于滞后判断)
};
```

---

### 4. **枚举定义**

```c
// DTS 电池表字段索引
enum bat_cccv_bat_tbl_type {
    BAT_CCCV_BAT_TBL_BRAND = 0,   // 电池品牌
    BAT_CCCV_BAT_TBL_PARAM,       // 参数表名称
    BAT_CCCV_BAT_TBL_END
};

// DTS 温度表字段索引
enum bat_cccv_tmp_tbl_type {
    BAT_CCCV_TMP_TBL_TBAT = 0,    // 温度阈值
    BAT_CCCV_TMP_TBL_CCCV,        // CCCV 表名称
    BAT_CCCV_TMP_TBL_END
};

// DTS CCCV 表字段索引
enum bat_cccv_tbl_type {
    BAT_CCCV_TBL_VBAT = 0,        // 电压
    BAT_CCCV_TBL_ICHG,            // 电流
    BAT_CCCV_TBL_TIME,            // 时间
    BAT_CCCV_TBL_END
};
```

---

## 三、关键功能模块

### 1. **事件回调处理**

```c
static int bat_cccv_event_cb(struct notifier_block *nb,
    unsigned long action, void *data)
{
    switch (action) {
    case POWER_NE_USB_DISCONNECT:
    case POWER_NE_WIRELESS_DISCONNECT:
        // USB/无线充电器断开：释放动态表，重置时间
        if (di->cccv_with_ratio_tbl)
            kfree(di->cccv_with_ratio_tbl);
        di->cccv_with_ratio_tbl = NULL;
        di->first_start_time = 0;
        break;
        
    case POWER_NE_DC_CHECK_SUCC:
    case POWER_NE_WLC_DC_START_CHARGING:
        // 直充/无线直充开始：记录首次充电时间
        if (!di->first_start_time) {
            di->first_start_time = (u32)power_get_current_kernel_time().tv_sec;
            di->last_vbat = 0;
        }
        break;
    }
    return 0;
}
```

**作用**：
- **断开事件** → 清理动态表，防止下次充电使用旧数据
- **充电开始** → 记录起始时间，用于后续基于时间的电流限制

---

### 2. **充电电流查询（核心接口）**

#### (1) 带比例查询：

```c
static int bat_cccv_get_ichg_with_ratio(struct bat_cccv_dev *di, 
    int vbat, u32 time_diff)
{
    int i;
    int hysteresis = 0;
    
    // 1. 电压滞后判断
    if (vbat < di->last_vbat)
        hysteresis = -BAT_CCCV_TMP_HYSTERESIS;  // -20mV
    
    di->last_vbat = vbat;
    
    // 2. 遍历动态表，查找匹配项
    for (i = 0; i < di->cccv_with_ratio_tbl_size; i++) {
        // 检查电压是否匹配（带滞后容差）
        if (vbat > (di->cccv_with_ratio_tbl[i].vbat + hysteresis))
            continue;
        
        // 检查时间限制（time > 0 表示有时间约束）
        if ((di->cccv_with_ratio_tbl[i].time > 0) && 
            (time_diff > di->cccv_with_ratio_tbl[i].time))
            continue;
        
        return di->cccv_with_ratio_tbl[i].ichg;
    }
    
    // 3. 未匹配返回最后一项
    return di->cccv_with_ratio_tbl[di->cccv_with_ratio_tbl_size - 1].ichg;
}
```

**滞后机制**：
- 当电压下降时（`vbat < last_vbat`），引入 -20mV 的滞后量
- 防止电压波动导致频繁切换充电电流

**时间约束**：
- 若 `cccv[i].time > 0`，则该段仅在充电时长 ≤ time 时有效
- 实现"充电前 X 秒使用较大电流"的策略

#### (2) 对外接口：

```c
int bat_cccv_get_ichg(int vbat)
{
    struct bat_cccv_dev *di = g_bat_cccv_dev;
    u32 time_diff = 0;
    
    if (!di)
        return -ENODEV;
    
    time_diff = (u32)power_get_current_kernel_time().tv_sec - di->first_start_time;
    return bat_cccv_get_ichg_with_ratio(di, vbat, time_diff);
}
```

---

### 3. **温度选择**

```c
static struct bat_cccv_tbat *bat_cccv_select_tbat_cccv(struct bat_cccv_dev *di)
{
    int i;
    int tbatt = POWER_SUPPLY_DEFAULT_TEMP / POWER_PLATFORM_BAT_TEMP_UNIT;
    
    // 1. 获取电池温度
    (void)power_supply_get_int_property_value(POWER_PLATFORM_BAT_PSY_NAME,
        POWER_SUPPLY_PROP_TEMP, &tbatt);
    tbatt = tbatt / POWER_PLATFORM_BAT_TEMP_UNIT;
    
    // 2. 遍历温度分组表，选择第一个温度低于阈值的组
    for (i = 0; i < di->tbat_cccv_tbl_group_size; i++) {
        if (tbatt < di->tbat_cccv_tbl[i].tbat_th)
            return &di->tbat_cccv_tbl[i];
    }
    
    return NULL;
}
```

**逻辑**：
- 温度表按阈值升序排列
- 选择第一个 `tbatt < tbat_th` 的组
- 示例：若温度表为 `[10°C, 25°C, 45°C]`，当前温度 20°C，则选择 25°C 组

---

### 4. **比例字符串解析**

```c
static int bat_cccv_parse_str_ichg_ratio(int *ichg_ratio_tbl, int len, char *buf)
{
    // 期望格式: "0@100,1@95,2@90"
    // 含义: stage@ratio
    
    char *tmp1 = NULL;
    char *tmp2 = NULL;
    
    tmp1 = strsep(&buf, ",");
    while (tmp1) {
        tmp2 = strsep(&tmp1, "@");  // 分割 "stage@ratio"
        
        // 解析 stage 和 ratio
        kstrtoint(tmp2, POWER_BASE_DEC, &stage);
        kstrtoint(tmp1, POWER_BASE_DEC, &ratio);
        
        if (stage == 0)
            total_ratio = ratio;  // 第一个是基准比例
        else
            ichg_ratio_tbl[stage - 1] = ratio;
        
        tmp1 = strsep(&buf, ",");
    }
    
    // 取 min(total_ratio, stage_ratio)
    for (i = 0; i < len; i++)
        ichg_ratio_tbl[i] = power_min_positive(total_ratio, ichg_ratio_tbl[i]);
    
    return 0;
}
```

**示例**：
```
输入: "0@100,1@95,2@90,3@85"

解析结果:
  total_ratio = 100
  ichg_ratio_tbl[0] = min(100, 95) = 95
  ichg_ratio_tbl[1] = min(100, 90) = 90
  ichg_ratio_tbl[2] = min(100, 85) = 85
```

---

### 5. **动态表生成**

```c
static int bat_cccv_update_ratio_ichg(struct bat_cccv_dev *di,
    int *ichg_ratio_tbl, struct bat_cccv_tbat *selected_tbat_cccv)
{
    int i;
    int pre_cur = 0;
    struct bat_cccv *local_cccv = NULL;
    
    // 1. 分配新表
    local_cccv = kzalloc(sizeof(struct bat_cccv) * stage_size, GFP_KERNEL);
    
    // 2. 计算每段的比例电流
    for (i = 0; i < stage_size; i++) {
        local_cccv[i].vbat = selected_tbat_cccv->cccv[i].vbat;
        
        // 按比例计算电流
        local_cccv[i].ichg = 
            selected_tbat_cccv->cccv[i].ichg * ichg_ratio_tbl[i] / BAT_CCCV_RATIO_UTIL;
        
        local_cccv[i].time = selected_tbat_cccv->cccv[i].time;
        
        // 确保电流单调递减（不允许后段电流大于前段）
        local_cccv[i].ichg = power_min_positive(pre_cur, local_cccv[i].ichg);
        pre_cur = local_cccv[i].ichg;
    }
    
    // 3. 替换旧表
    if (di->cccv_with_ratio_tbl)
        kfree(di->cccv_with_ratio_tbl);
    
    di->cccv_with_ratio_tbl = local_cccv;
    di->cccv_with_ratio_tbl_size = stage_size;
    
    return 0;
}
```

**关键点**：
- **比例计算** → `ichg_new = ichg_orig × ratio / 100`
- **单调性保证** → 后段电流不能超过前段（防止充电电流突增）

---

### 6. **Sysfs 接口**

#### 节点定义：

```c
static struct power_sysfs_attr_info bat_cccv_sysfs_field_tbl[] = {
    power_sysfs_attr_rw(bat_cccv, 0220,
        BAT_CCCV_SYSFS_UPDATE_ICHG_RATIO, update_ichg_ratio),
};
```

#### Store 函数：

```c
static ssize_t bat_cccv_sysfs_store(struct device *dev,
    struct device_attribute *attr, const char *buf, size_t count)
{
    char saved_buf[BAT_CCCV_BUF_MAX_SIZE] = { 0 };
    
    switch (info->name) {
    case BAT_CCCV_SYSFS_UPDATE_ICHG_RATIO:
        // 保存输入字符串
        snprintf_s(saved_buf, BAT_CCCV_BUF_MAX_SIZE, 
            BAT_CCCV_BUF_MAX_SIZE - 1, "%s", buf);
        
        // 处理比例更新
        bat_cccv_handle_ichg_ratio(di, saved_buf);
        break;
    }
    
    return count;
}
```

#### 完整流程：

```c
bat_cccv_handle_ichg_ratio(di, buf)
    ↓
1. 选择当前温度对应的基准表
   selected_tbat_cccv = bat_cccv_select_tbat_cccv(di);
    ↓
2. 解析比例字符串
   bat_cccv_parse_str_ichg_ratio(ichg_ratio_tbl, stage_count, buf);
    ↓
3. 生成动态表
   bat_cccv_update_ratio_ichg(di, ichg_ratio_tbl, selected_tbat_cccv);
```

#### 节点路径：

```bash
/sys/class/hw_power/battery/battery_cccv/update_ichg_ratio (WO, 0220)
```

---

### 7. **DTS 配置解析**

#### (1) CCCV 表解析：

```c
static int bat_cccv_parse_cccv(struct device_node *node,
    const char *tab_name, struct bat_cccv_tbat *cccv_tbat)
{
    // 读取 u32 数组，每 3 个为一组 (vbat, ichg, time)
    len = power_dts_read_u32_count(power_dts_tag(HWLOG_TAG), node,
        tab_name, BAT_CCCV_MAX_STAGE, BAT_CCCV_TBL_END);
    
    cccv_tbat->stage_size = len / BAT_CCCV_TBL_END;
    
    for (i = 0; i < len; i++) {
        power_dts_read_u32_index(..., tab_name, i, &data);
        
        row = i / BAT_CCCV_TBL_END;
        col = i % BAT_CCCV_TBL_END;
        
        switch (col) {
        case BAT_CCCV_TBL_VBAT:
            cccv_tbat->cccv[row].vbat = (int)data;
            break;
        case BAT_CCCV_TBL_ICHG:
            cccv_tbat->cccv[row].ichg = (int)data;
            break;
        case BAT_CCCV_TBL_TIME:
            cccv_tbat->cccv[row].time = (int)data;
            hwlog_info("%dmV %dmA %us\n", vbat, ichg, time);
            break;
        }
    }
}
```

#### (2) 温度分组解析：

```c
static int bat_cccv_parse_tbat_dts(struct device_node *node, 
    struct bat_cccv_dev *di, const char *select_param)
{
    // 查找子节点 (如 "cccv_para0")
    sub_node = of_find_node_by_name(node, select_param);
    
    // 读取 temp_tab 字符串数组
    // 格式: ["25", "cccv_25c", "45", "cccv_45c"]
    len = power_dts_read_count_strings(..., "temp_tab", ...);
    
    di->tbat_cccv_tbl_group_size = len / BAT_CCCV_TMP_TBL_END;
    
    for (i = 0; i < len; i++) {
        power_dts_read_string_index(..., "temp_tab", i, &str);
        
        switch (i % BAT_CCCV_TMP_TBL_END) {
        case BAT_CCCV_TMP_TBL_TBAT:
            // 解析温度阈值
            kstrtoint(str, POWER_BASE_DEC, &idata);
            di->tbat_cccv_tbl[i / 2].tbat_th = idata;
            break;
        case BAT_CCCV_TMP_TBL_CCCV:
            // 解析对应的 CCCV 表
            bat_cccv_parse_cccv(sub_node, str, &(di->tbat_cccv_tbl[i / 2]));
            break;
        }
    }
}
```

#### (3) 品牌匹配：

```c
static int bat_cccv_match_brand(struct device_node *node, 
    const char *select_param)
{
    const char *batt_brand = "default";
    
    // 1. 获取电池品牌
    power_supply_get_str_property_value(POWER_PLATFORM_BAT_PSY_NAME,
        POWER_SUPPLY_PROP_BRAND, &batt_brand);
    
    // 2. 读取 battery_tbl
    // 格式: ["SUNWODA", "cccv_para0", "DESAY", "cccv_para1"]
    len = power_dts_read_count_strings(..., "battery_tbl", ...);
    
    // 3. 遍历匹配品牌
    for (i = 0; i < len; i++) {
        switch (i % BAT_CCCV_BAT_TBL_END) {
        case BAT_CCCV_BAT_TBL_BRAND:
            power_dts_read_string_index(..., "battery_tbl", i, &string);
            if (strcmp(string, batt_brand))
                i++;  // 品牌不匹配，跳过参数名
            break;
        case BAT_CCCV_BAT_TBL_PARAM:
            // 返回参数表名称
            return power_dts_read_string_index(..., "battery_tbl", i, &select_param);
        }
    }
}
```

---

## 四、DTS 配置示例

```
battery_cccv {
    compatible = "huawei,battery_cccv";
    
    /* 电池品牌与参数表映射 */
    battery_tbl = <
        "SUNWODA"  "cccv_para0"
        "DESAY"    "cccv_para1"
        "default"  "cccv_para0"
    >;
    
    /* 参数表 0 (SUNWODA) */
    cccv_para0 {
        /* 温度分组: [温度阈值, CCCV表名称] */
        temp_tab = <
            "25"  "cccv_25c"
            "45"  "cccv_45c"
        >;
        
        /* 25°C 以下的 CCCV 表 */
        /* 格式: vbat(mV), ichg(mA), time(s) */
        cccv_25c = <
            3800  3000  0      /* 3.8V, 3000mA, 无时间限制 */
            4000  2500  0      /* 4.0V, 2500mA, 无时间限制 */
            4200  2000  0      /* 4.2V, 2000mA, 无时间限制 */
            4350  1500  0      /* 4.35V, 1500mA, 无时间限制 */
            4400  1000  0      /* 4.4V, 1000mA, 无时间限制 */
        >;
        
        /* 25°C ~ 45°C 的 CCCV 表 */
        cccv_45c = <
            3800  3500  600    /* 3.8V, 3500mA, 前 10 分钟 */
            3800  3000  0      /* 3.8V, 3000mA, 之后 */
            4000  2800  0      /* 4.0V, 2800mA */
            4200  2200  0      /* 4.2V, 2200mA */
            4350  1800  0      /* 4.35V, 1800mA */
            4400  1200  0      /* 4.4V, 1200mA */
        >;
    };
};
```

---

## 五、使用流程

### 1. **系统启动**

```
bat_cccv_probe()
    ↓
bat_cccv_parse_dts()
    ↓
bat_cccv_match_brand()  // 根据电池品牌选择参数表
    ↓
bat_cccv_parse_tbat_dts()  // 解析温度分组
    ↓
bat_cccv_parse_cccv()  // 解析每组的 CCCV 表
```

### 2. **充电开始**

```
POWER_NE_DC_CHECK_SUCC 事件触发
    ↓
bat_cccv_event_cb()
    ↓
记录 first_start_time = 当前时间
```

### 3. **动态调整（可选）**

```bash
# 通过 sysfs 写入比例字符串
echo "0@100,1@95,2@90,3@85" > \
    /sys/class/hw_power/battery/battery_cccv/update_ichg_ratio
```

```
sysfs write
    ↓
bat_cccv_handle_ichg_ratio()
    ↓
bat_cccv_select_tbat_cccv()  // 根据当前温度选择基准表
    ↓
bat_cccv_parse_str_ichg_ratio()  // 解析比例字符串
    ↓
bat_cccv_update_ratio_ichg()  // 生成动态表
    ↓
cccv_with_ratio_tbl 生效
```

### 4. **运行时查询**

```c
// 充电管理模块调用
int vbat = 4000;  // 当前电池电压 4.0V
int ichg = bat_cccv_get_ichg(vbat);

// 内部流程
bat_cccv_get_ichg(4000)
    ↓
time_diff = 当前时间 - first_start_time
    ↓
bat_cccv_get_ichg_with_ratio(di, 4000, time_diff)
    ↓
遍历 cccv_with_ratio_tbl:
  - 检查 vbat 是否匹配 (带滞后)
  - 检查 time_diff 是否满足约束
    ↓
返回 ichg = 2500mA
```

---

## 六、关键算法

### 1. **电压滞后机制**

```c
// 防止电压波动导致频繁切换
if (vbat < di->last_vbat)
    hysteresis = -BAT_CCCV_TMP_HYSTERESIS;  // -20mV

// 匹配条件
if (vbat > (cccv_tbl[i].vbat + hysteresis))
    continue;  // 未达到该段
```

**作用**：
- 电压上升时：直接匹配
- 电压下降时：允许 -20mV 容差，防止抖动

**示例**：
```
当前段: vbat_th = 4000mV
- 电压上升: 4000mV → 匹配
- 电压下降: 3980mV → 仍匹配 (4000 - 20 = 3980)
- 电压继续降: 3970mV → 切换到上一段
```

### 2. **单调性保证**

```c
for (i = 0; i < stage_size; i++) {
    local_cccv[i].ichg = orig_ichg * ratio / 100;
    
    // 确保不超过前一段电流
    local_cccv[i].ichg = power_min_positive(pre_cur, local_cccv[i].ichg);
    pre_cur = local_cccv[i].ichg;
}
```

**作用**：
- 保证充电电流随电压升高而递减
- 防止出现"4.0V → 2500mA, 4.2V → 3000mA"的不合理情况

---

## 七、典型应用场景

### 场景 1：正常充电流程

```
1. 插入充电器，触发 POWER_NE_DC_CHECK_SUCC
2. 记录 first_start_time = 100 (秒)
3. 当前温度 30°C，选择 cccv_45c 表
4. 电池电压 3850mV
5. 查询 bat_cccv_get_ichg(3850):
   - time_diff = 当前时间 - 100 = 50s
   - 匹配项: vbat=3800, ichg=3500, time=600
   - 50s < 600s，返回 ichg = 3500mA
6. 600 秒后再次查询:
   - time_diff = 650s
   - 第一项 time=600 已超时，匹配下一项
   - 匹配项: vbat=3800, ichg=3000, time=0
   - 返回 ichg = 3000mA
```

### 场景 2：动态比例调整

```
1. 当前使用基准表 (温度 30°C):
   3800mV → 3000mA
   4000mV → 2500mA
   4200mV → 2000mA

2. 通过 sysfs 写入比例 "0@100,1@90,2@80,3@70":
   echo "0@100,1@90,2@80,3@70" > update_ichg_ratio

3. 生成新表:
   3800mV → 3000 × 90/100 = 2700mA
   4000mV → 2500 × 80/100 = 2000mA
   4200mV → 2000 × 70/100 = 1400mA

4. 查询 bat_cccv_get_ichg(4000) 返回 2000mA (已降低)
```

### 场景 3：温度变化

```
1. 初始温度 20°C，使用 cccv_25c 表
2. 充电过程中温度升至 30°C
3. 用户通过 sysfs 更新比例:
   - bat_cccv_select_tbat_cccv() 自动选择 cccv_45c 表
   - 基于新表生成动态表
4. 后续查询使用新温度区间的充电曲线
```

---

## 八、调试方法

### 1. **查看日志**

```bash
dmesg | grep battery_cccv

# 典型输出
battery_cccv: cccv_para0:cccv_25c[0]: 3800mV 3000mA 0s
battery_cccv: cccv_para0:cccv_25c[1]: 4000mV 2500mA 0s
battery_cccv: origin buf=0@100,1@95, saved buf=0@100,1@95
```

### 2. **测试 Sysfs**

```bash
# 查看节点权限
ls -l /sys/class/hw_power/battery/battery_cccv/
# -w--w---- ... update_ichg_ratio

# 写入比例字符串
echo "0@100,1@95,2@90" > \
    /sys/class/hw_power/battery/battery_cccv/update_ichg_ratio

# 查看 dmesg 确认解析成功
dmesg | tail -10
```

### 3. **验证充电电流**

```bash
# 读取当前充电电流
cat /sys/class/power_supply/battery/current_now

# 读取电池电压
cat /sys/class/power_supply/battery/voltage_now

# 对比是否符合 CCCV 表预期
```

### 4. **模拟事件触发**

```bash
# 模拟充电断开（需要权限）
echo POWER_NE_USB_DISCONNECT > /sys/.../power_event
# 观察是否释放动态表（通过日志或内存查看）
```

---

## 九、注意事项

### 1. **比例字符串格式严格**

```bash
# 正确格式
"0@100,1@95,2@90"

# 错误格式（会被拒绝）
"0 @ 100, 1 @ 95"  # 多余空格
"95,90,85"         # 缺少 stage 索引
"0@50,1@95"        # 第一个比例 < 70 (BAT_CCCV_RATIO_MIN)
```

### 2. **温度表顺序**

```
/* 正确：按温度升序排列 */
temp_tab = <
    "25"  "cccv_25c"
    "45"  "cccv_45c"
>;

/* 错误：顺序混乱会导致选择逻辑错误 */
temp_tab = <
    "45"  "cccv_45c"
    "25"  "cccv_25c"
>;
```

### 3. **时间约束理解**

```c
// time = 0: 无时间限制，一直有效
// time > 0: 仅在充电开始后 time 秒内有效

// 示例：快充前 10 分钟使用大电流
cccv = <
    3800  3500  600    // 前 10 分钟 (600s) 使用 3500mA
    3800  3000  0      // 之后使用 3000mA
>;
```

### 4. **内存泄漏风险**

```c
// 每次更新都会分配新表并释放旧表
// 若频繁更新需注意：
// 1. 检查 kfree 是否正确调用
// 2. 避免高频写入 sysfs
```

---

## 十、总结

**battery_cccv.c 核心特性：**

| 特性 | 实现方式 | 价值 |
|------|---------|------|
| **温度适应** | 多温度分组表 | 不同温度使用不同充电策略 |
| **动态调整** | Sysfs 比例接口 | 运行时优化充电速度 |
| **时间约束** | 首次充电时间戳 | 实现分时段充电 |
| **电压滞后** | 20mV 容差 | 防止抖动切换 |
| **品牌适配** | 品牌匹配机制 | 支持多电池型号 |

**应用场景：**
- 快充算法（前期大电流，后期小电流）
- 温控充电（高温降流，低温慢充）
- 电池保护（动态限流防过充）
- 老化适配（通过比例降低充电功率）

这是华为电源管理框架中**充电曲线智能管理的核心模块**！