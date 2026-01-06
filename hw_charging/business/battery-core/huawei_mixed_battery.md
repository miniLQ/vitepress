---
outline: deep
---

# huawei_mixed_battery 模块代码解析

## 模块概述

`huawei_mixed_battery` 是华为电源管理子系统中的 **Power Supply 合并代理驱动**，用于将**多个独立的 power supply 设备**（如双电池、双库仑计）**聚合成单一的 "battery" power supply 接口**，对上层（Android Framework）呈现为统一的电池设备。

**核心功能：**
- **多 Power Supply 聚合：** 将多个子 power supply（如 battery_gauge、battery_gauge_aux）合并为一个 "battery"
- **属性透传代理：** 自动转发 get/set property 请求到第一个支持该属性的子设备
- **属性去重合并：** 合并所有子设备的属性列表，去除重复项
- **事件同步转发：** 监听所有子设备的 power_supply_changed 事件，统一转发到合并后的 battery
- **动态属性聚合：** 运行时动态构建属性列表，支持灵活配置

**典型应用场景：**

```
折叠屏双电池系统：

┌─────────────────────────────────────┐
│   Android Framework (Battery API)   │
└──────────────┬──────────────────────┘
               │
         ┌─────▼─────┐
         │  battery  │ ← huawei_mixed_battery 虚拟设备
         └─────┬─────┘
               │
      ┌────────┴────────┐
      │                 │
┌─────▼─────┐     ┌────▼──────┐
│ battery_  │     │ battery_  │
│  gauge    │     │gauge_aux  │
└───────────┘     └───────────┘
      │                 │
   主电池            辅助电池
```

---

## 主要数据结构

### 设备结构体 `mixed_batt`

```c
struct mixed_batt {
    struct device *dev;                           // 设备指针
    struct power_supply *batt;                    // 合并后的 battery power supply
    struct notifier_block psy_nb;                 // power supply 事件通知块
    int psy_cnt;                                  // 子 power supply 数量
    const char *sub_psy[BATT_PSY_SUB_PSY_MAX];   // 子 power supply 名称数组（最多 5 个）
};
```

**成员说明：**
- `batt`: 对外暴露的统一 "battery" 接口
- `psy_cnt`: 实际配置的子设备数量（1-5）
- `sub_psy[]`: 子设备名称列表（如 "battery_gauge", "battery_gauge_aux"）

---

## 核心机制

### 1. 属性读取代理 `mixed_batt_get_property()`

**转发逻辑：**

```c
遍历所有子 power supply（按配置顺序）：
    for (i = 0; i < di->psy_cnt; i++) {
        ret = power_supply_get_property_value(sub_psy[i], psp, val);
        if (成功)
            return 第一个成功的值;  // 短路返回
    }
    return -ENODEV;  // 所有子设备都不支持该属性
```

**示例场景：**

```c
配置：psy-names = "battery_gauge", "battery_gauge_aux"

读取 POWER_SUPPLY_PROP_CAPACITY（电量）：
1. 尝试从 battery_gauge 读取 → 成功，返回 85%
2. 不再尝试 battery_gauge_aux（短路优化）

读取 POWER_SUPPLY_PROP_TEMP（温度）：
1. 尝试从 battery_gauge 读取 → 失败（不支持）
2. 尝试从 battery_gauge_aux 读取 → 成功，返回 25°C
```

**设计理念：**
- **优先级机制：** 配置顺序决定优先级，第一个子设备优先级最高
- **容错机制：** 单个子设备失败不影响其他设备的查询
- **性能优化：** 短路返回，避免不必要的查询

### 2. 属性写入代理 `mixed_batt_set_property()`

**转发逻辑：**

```c
遍历所有子 power supply：
    for (i = 0; i < di->psy_cnt; i++) {
        ret = power_supply_set_property_value(sub_psy[i], psp, val);
        if (成功)
            return;  // 仅设置第一个支持的设备
    }
    return -ENODEV;
```

**示例场景：**

```c
写入 POWER_SUPPLY_PROP_INPUT_CURRENT_LIMIT（输入电流限制）：
1. 尝试写入 battery_gauge → 失败（只读属性）
2. 尝试写入 battery_gauge_aux → 成功，设置为 2000mA
```

**日志输出：**
```
mixed_batt: prop to battery_gauge_aux
```

### 3. 属性合并算法 `mixed_batt_creat_desc()`

**合并流程：**

```c
步骤 1：遍历所有子 power supply，统计总属性数
    prop_cnt = Σ(sub_psy[i].num_properties)

步骤 2：分配属性数组内存
    prop_ptr = kzalloc(sizeof(enum power_supply_property) * prop_cnt)

步骤 3：去重合并所有属性
    for each sub_psy:
        for each property in sub_psy:
            if property not in prop_ptr:
                prop_ptr[widx++] = property

步骤 4：更新 power supply 描述符
    mixed_batt_desc.properties = prop_ptr
    mixed_batt_desc.num_properties = widx
```

**去重算法：**

```c
int batt_props_add(enum power_supply_property *dst_prop, int dts_len,
    int wp, struct power_supply *psy)
{
    for (j = 0; j < psy->desc->num_properties; j++) {
        // 线性查找：检查属性是否已存在
        for (k = 0; k < wp; k++) {
            if (dst_prop[k] == psy->desc->properties[j])
                break;  // 重复属性，跳过
        }
        if (k < wp)
            continue;  // 已存在
        
        dst_prop[wp++] = psy->desc->properties[j];  // 新属性，添加
    }
    return wp;
}
```

**示例：**

```
子设备 1（battery_gauge）属性：
  CAPACITY, VOLTAGE_NOW, CURRENT_NOW, TEMP

子设备 2（battery_gauge_aux）属性：
  CAPACITY, VOLTAGE_NOW, CYCLE_COUNT

合并后属性（去重）：
  CAPACITY, VOLTAGE_NOW, CURRENT_NOW, TEMP, CYCLE_COUNT
```

### 4. 可写属性检测 `mixed_batt_property_is_writeable()`

**检测逻辑：**

```c
遍历所有子 power supply：
    for (i = 0; i < di->psy_cnt; i++) {
        if (sub_psy[i] 支持该属性写入)
            return 1;  // 只要有一个支持即可写
    }
    return 0;  // 全部不支持
```

**用途：** Android Framework 通过此接口判断属性是否可设置。

---

## 事件同步机制

### 通知回调 `mixed_batt_notifier_call()`

**工作流程：**

```
1. 子 power supply 状态变化
   ↓
   power_supply_changed(battery_gauge)
   ↓
2. 触发全局 power supply 通知链
   ↓
3. mixed_batt_notifier_call() 被调用
   ↓
4. 检查是否为配置的子设备
   ↓
5. 转发事件到合并后的 battery
   ↓
   power_supply_changed(di->batt)
   ↓
6. Android Framework 接收到事件并更新 UI
```

**代码实现：**

```c
static int mixed_batt_notifier_call(struct notifier_block *nb,
    unsigned long action, void *data)
{
    struct power_supply *psy = data;
    struct mixed_batt *di = container_of(nb, struct mixed_batt, psy_nb);

    for (i = 0; i < di->psy_cnt; i++) {
        if (strcmp(psy->desc->name, di->sub_psy[i]))
            continue;  // 不是配置的子设备，忽略
        
        hwlog_info("updata from %s\n", di->sub_psy[i]);
        power_supply_changed(di->batt);  // 转发事件
        break;
    }
    return NOTIFY_OK;
}
```

**日志示例：**
```
mixed_batt: updata from battery_gauge
```

---

## DTS 配置

### 配置示例

```
huawei_mixed_battery {
    compatible = "huawei,mixed_batt";
    
    /* 子 power supply 名称列表（按优先级排序） */
    psy-names = "battery_gauge", "battery_gauge_aux";
};
```

### 配置约束

| 参数 | 类型 | 范围 | 说明 |
|------|------|------|------|
| `psy-names` | string[] | 1-5 个元素 | 子 power supply 名称，顺序决定属性读取优先级 |

**有效配置示例：**

```
/* 双电池配置 */
psy-names = "battery_gauge", "battery_gauge_aux";

/* 单电池配置（兼容性） */
psy-names = "battery_gauge";

/* 三电池配置（理论支持，实际较少） */
psy-names = "batt_main", "batt_aux1", "batt_aux2";
```

**无效配置：**

```
/* 错误 1：空列表 */
psy-names = "";  // probe 失败

/* 错误 2：超过最大数量 */
psy-names = "b1", "b2", "b3", "b4", "b5", "b6";  // 超过 BATT_PSY_SUB_PSY_MAX(5)
```

---

## 属性访问流程

### 读取属性完整流程

```
Android Framework
    ↓
/sys/class/power_supply/battery/capacity
    ↓
power_supply_show_property()
    ↓
mixed_batt_get_property(psp=POWER_SUPPLY_PROP_CAPACITY)
    ↓
遍历 sub_psy[]:
    ├─ power_supply_get_property_value("battery_gauge", CAPACITY)
    │   ↓
    │   battery_gauge_get_property()  // 子设备的 get_property
    │   ↓
    │   返回 85  // 成功
    └─ 返回 85 给 Android
```

### 写入属性完整流程

```
Android Framework
    ↓
echo 2000 > /sys/class/power_supply/battery/input_current_limit
    ↓
power_supply_store_property()
    ↓
mixed_batt_property_is_writeable(INPUT_CURRENT_LIMIT)
    ↓
检查所有子设备：
    ├─ battery_gauge → 不支持写入
    └─ battery_gauge_aux → 支持写入 ✓
    ↓
mixed_batt_set_property(INPUT_CURRENT_LIMIT, 2000)
    ↓
遍历 sub_psy[]:
    ├─ battery_gauge.set_property() → 失败
    └─ battery_gauge_aux.set_property() → 成功，设置 2000mA
```

---

## 典型应用场景

### 场景 1：折叠屏双电池系统

**硬件配置：**
- 主屏电池：3500mAh（battery_gauge）
- 副屏电池：2500mAh（battery_gauge_aux）

**DTS 配置：**

```
huawei_mixed_battery {
    compatible = "huawei,mixed_batt";
    psy-names = "battery_gauge", "battery_gauge_aux";
};
```

**属性合并结果：**

| 属性 | battery_gauge | battery_gauge_aux | 合并后 battery |
|------|--------------|------------------|---------------|
| CAPACITY | ✓（主） | ✓ | ✓（优先读取主电池） |
| VOLTAGE_NOW | ✓ | ✓ | ✓（读取主电池电压） |
| CURRENT_NOW | ✓ | ✓ | ✓（读取主电池电流） |
| TEMP | ✓ | ✓ | ✓（读取主电池温度） |
| CYCLE_COUNT | ✓ | ✓ | ✓（读取主电池循环次数） |

**Android 视角：**
```
adb shell dumpsys battery
  level: 85          // 从 battery_gauge 读取
  voltage: 3850      // 从 battery_gauge 读取
  temperature: 250   // 从 battery_gauge 读取
  technology: Li-ion
```

### 场景 2：单电池兼容性配置

**硬件配置：**
- 单电池系统（battery_gauge）

**DTS 配置：**

```
huawei_mixed_battery {
    compatible = "huawei,mixed_batt";
    psy-names = "battery_gauge";  // 仅一个子设备
};
```

**设计目的：** 统一不同硬件配置的软件接口，上层代码无需区分单电池/双电池。

### 场景 3：库仑计 + 温度传感器分离

**硬件配置：**
- 库仑计设备：提供 SOC、电压、电流（battery_gauge）
- 温度传感器设备：提供电池温度（battery_temp_sensor）

**DTS 配置：**

```
huawei_mixed_battery {
    compatible = "huawei,mixed_batt";
    psy-names = "battery_gauge", "battery_temp_sensor";
};
```

**属性读取：**
```c
读取 CAPACITY  → battery_gauge（成功）
读取 TEMP      → battery_gauge（失败） → battery_temp_sensor（成功）
```

---

## 驱动生命周期

### 初始化流程 `mixed_batt_probe()`

```
1. 分配设备结构体
   ↓
2. 解析 DTS（mixed_batt_parse_dts）
   ├─ 读取 psy-names 数组
   └─ 验证数量 1-5
   ↓
3. 创建 power supply 描述符（mixed_batt_creat_desc）
   ├─ 获取所有子 power supply 对象
   ├─ 合并属性列表（去重）
   └─ 构建 mixed_batt_desc
   ↓
4. 注册 power supply
   ↓
   power_supply_register(&pdev->dev, &mixed_batt_desc, NULL)
   ↓
5. 注册 power supply 通知链
   ↓
   power_supply_reg_notifier(&di->psy_nb)
   ↓
6. 完成初始化
   └─ 创建 /sys/class/power_supply/battery/
```

### DTS 解析详细流程

```c
static int mixed_batt_parse_dts(struct mixed_batt *di)
{
    // 1. 获取 psy-names 数组长度
    len = of_property_count_strings(np, "psy-names");
    
    // 2. 验证长度（1-5）
    if (len <= 0 || len > BATT_PSY_SUB_PSY_MAX)
        return -EINVAL;
    
    // 3. 逐个读取子设备名称
    for (i = 0; i < len; i++) {
        ret = power_dts_read_string_index(np, "psy-names", i, &di->sub_psy[i]);
        if (ret)
            return -EINVAL;
    }
    
    di->psy_cnt = len;
    return 0;
}
```

### 属性描述符构建详细流程

```c
static int mixed_batt_creat_desc(struct mixed_batt *di)
{
    // 1. 获取所有子 power supply 对象
    for (i = 0; i < di->psy_cnt; i++) {
        psy[i] = power_supply_get_by_name(di->sub_psy[i]);
        if (!psy[i])
            return -ENODEV;  // 子设备未注册
        
        prop_cnt += psy[i]->desc->num_properties;
    }
    
    // 2. 分配属性数组（最大可能大小）
    prop_ptr = devm_kzalloc(di->dev, sizeof(*prop_ptr) * prop_cnt, GFP_KERNEL);
    
    // 3. 去重合并属性
    for (i = 0; i < di->psy_cnt; i++) {
        widx = batt_props_add(prop_ptr, prop_cnt, widx, psy[i]);
    }
    
    // 4. 更新描述符
    mixed_batt_desc.properties = prop_ptr;
    mixed_batt_desc.num_properties = widx;
    
    // 5. 释放临时引用
    for (i = 0; psy[i] != NULL; i++)
        power_supply_put(psy[i]);
    
    return 0;
}
```

### 卸载流程 `mixed_batt_remove()`

```
1. 注销 power supply 通知链
   ↓
   power_supply_unreg_notifier(&di->psy_nb)
   ↓
2. 注销 power supply
   ↓
   power_supply_unregister(di->batt)
   ↓
3. 清理 /sys/class/power_supply/battery/
```

### 模块加载优先级

```c
late_initcall_sync(mixed_batt_init);
```

**说明：** 使用 `late_initcall_sync` 确保在所有子 power supply 驱动加载完成后再加载，避免 `power_supply_get_by_name()` 失败。

---

## 调试技巧

### 1. 查看合并后的属性列表

```bash
ls /sys/class/power_supply/battery/
```

输出示例：
```
capacity
current_now
cycle_count
status
temp
type
voltage_now
...
```

### 2. 查看属性读取优先级

在 huawei_mixed_battery.c 中添加日志：

```c
for (i = 0; i < di->psy_cnt; i++) {
    ret = power_supply_get_property_value(di->sub_psy[i], psp, val);
    hwlog_info("try %s prop %d: ret=%d\n", di->sub_psy[i], psp, ret);
    if (!ret)
        return ret;
}
```

输出示例：
```
mixed_batt: try battery_gauge prop 17: ret=0  // CAPACITY 成功
mixed_batt: try battery_gauge prop 30: ret=-22  // 不支持该属性
mixed_batt: try battery_gauge_aux prop 30: ret=0  // 从辅助电池读取成功
```

### 3. 监控事件转发

```bash
dmesg | grep "updata from"
```

输出示例：
```
mixed_batt: updata from battery_gauge
mixed_batt: updata from battery_gauge_aux
```

### 4. 验证属性去重

在 huawei_mixed_battery.c 中添加日志：

```c
for (j = 0; j < psy->desc->num_properties; j++) {
    for (k = 0; k < wp; k++) {
        if (dst_prop[k] == psy->desc->properties[j]) {
            hwlog_info("prop %d duplicated, skip\n", psy->desc->properties[j]);
            break;
        }
    }
    if (k < wp)
        continue;
    
    hwlog_info("add prop %d from %s\n", psy->desc->properties[j], psy->desc->name);
    dst_prop[wp++] = psy->desc->properties[j];
}
```

### 5. 测试属性写入

```bash
# 检查是否可写
cat /sys/class/power_supply/battery/input_current_limit
# 如果可读，尝试写入
echo 2000 > /sys/class/power_supply/battery/input_current_limit
dmesg | grep "prop to"
```

输出示例：
```
mixed_batt: prop to battery_gauge_aux
```

---

## 错误处理

### 常见错误场景

#### 1. 子设备未注册

**错误日志：**
```
mixed_batt: battery_gauge not exist
mixed_batt: mixed_batt_probe err
```

**原因分析：**
- 子 power supply 驱动未加载
- 子设备名称配置错误
- 加载顺序问题（子设备在 mixed_batt 之后加载）

**解决方案：**

```c
// 方案 1：调整加载顺序（在子设备驱动中）
subsys_initcall(battery_gauge_init);  // 提前加载

// 方案 2：延迟加载 mixed_batt（不推荐）
device_initcall(mixed_batt_init);  // 改为 device_initcall
```

#### 2. 属性数组溢出

**错误日志：**
```
mixed_batt: batt_props_add return -ENOMEM
```

**原因：** 所有子设备的属性总数超过初始分配大小（理论上不会发生，已预分配足够空间）。

#### 3. DTS 配置错误

**错误日志：**
```
mixed_batt: psy-names dts err
```

**检查项：**
```
/* 检查是否存在 psy-names 属性 */
psy-names = "battery_gauge", "battery_gauge_aux";

/* 检查数量是否在 1-5 范围内 */
```

---

## 性能优化

### 1. 短路返回优化

```c
// 优化前：遍历所有子设备
for (i = 0; i < di->psy_cnt; i++) {
    ret = power_supply_get_property_value(di->sub_psy[i], psp, val);
}

// 优化后：第一个成功即返回
for (i = 0; i < di->psy_cnt; i++) {
    ret = power_supply_get_property_value(di->sub_psy[i], psp, val);
    if (!ret)
        return ret;  // 立即返回
}
```

**优势：** 对于高频访问的属性（如 CAPACITY），避免不必要的设备查询。

### 2. 属性缓存（未实现，可扩展）

**建议实现：**

```c
struct mixed_batt {
    // 添加缓存
    struct {
        int capacity;
        int voltage;
        ktime_t timestamp;
    } cache;
};

static int mixed_batt_get_property(struct power_supply *psy,
    enum power_supply_property psp, union power_supply_propval *val)
{
    // 缓存热点属性（如 CAPACITY），100ms 内直接返回缓存值
    if (psp == POWER_SUPPLY_PROP_CAPACITY) {
        if (ktime_ms_delta(ktime_get(), di->cache.timestamp) < 100) {
            val->intval = di->cache.capacity;
            return 0;
        }
    }
    
    // 正常流程...
}
```

---

## 关键宏定义

```c
#define BATT_PSY_SUB_PSY_MAX   5  // 最大支持 5 个子 power supply
```

---

## 总结

`huawei_mixed_battery` 模块通过 **power supply 代理模式**，实现了多电池系统的统一接口抽象。核心亮点包括：

1. **透明聚合：** 对 Android Framework 完全透明，无需修改上层代码
2. **优先级机制：** 通过配置顺序控制属性读取优先级，灵活适配不同硬件
3. **属性去重：** 自动合并所有子设备属性，避免重复暴露
4. **事件同步：** 实时转发子设备变化事件，确保 UI 及时更新
5. **容错设计：** 单个子设备失败不影响其他设备查询
6. **动态构建：** 运行时动态聚合属性列表，支持灵活的硬件配置

该模块是华为折叠屏、双电池设备的核心电源管理组件，简化了上层软件架构，提升了系统可维护性和可扩展性。