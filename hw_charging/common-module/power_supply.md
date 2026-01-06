---
outline: deep
---

# Power Supply 模块分析

## 1. 模块定位与核心价值

### 1.1 模块定位
**power_supply** 是华为MATE X5电源管理子系统的**电源设备抽象层**，作为Linux内核标准power_supply框架与华为电源驱动之间的**适配桥梁**。它封装了6种电源类型（电池、原始电池、辅助电池、市电、USB、无线充电），为上层应用和Android框架提供统一的电源属性访问接口。

### 1.2 核心价值
1. **标准化适配**：将华为自定义的电源驱动适配到Linux标准power_supply框架
2. **多电源支持**：同时管理多种电源类型（主电池、辅助电池、充电器等）
3. **回调机制**：通过ops注册机制解耦底层驱动和上层框架
4. **应用层封装**：提供简化的应用层接口，屏蔽底层实现细节
5. **灵活配置**：支持通过DTS配置启用/禁用特定电源类型

### 1.3 在Android系统中的位置
```
┌─────────────────────────────────────────────────────────┐
│          Android Framework (BatteryService)             │
└────────────────────┬────────────────────────────────────┘
                     │ /sys/class/power_supply/
┌────────────────────┴────────────────────────────────────┐
│         Linux Power Supply Framework (内核标准)          │
└────────────────────┬────────────────────────────────────┘
                     │ power_supply_register()
┌────────────────────┴────────────────────────────────────┐
│          power_supply Module (适配层) ← 当前模块         │
│  ┌──────────┐  ┌──────────┐  ┌──────────┐             │
│  │ Battery  │  │   USB    │  │ Wireless │  ...        │
│  └────┬─────┘  └────┬─────┘  └────┬─────┘             │
└───────┼─────────────┼─────────────┼────────────────────┘
        │             │             │ power_supply_ops_register()
┌───────┴─────────────┴─────────────┴────────────────────┐
│      Hardware Drivers (coul/charger/wireless)          │
└─────────────────────────────────────────────────────────┘
```

---

## 2. 模块架构

### 2.1 三层架构设计
```
┌─────────────────────────────────────────────────────────┐
│  Layer 3: Application (power_supply_application.c)     │
│  • power_supply_app_get_bat_capacity()                 │
│  • power_supply_app_get_bat_temp()                     │
│  • power_supply_app_get_usb_voltage_now()              │
│  作用：为其他内核模块提供便捷访问接口                    │
└────────────────────┬────────────────────────────────────┘
                     │
┌────────────────────┴────────────────────────────────────┐
│  Layer 2: Interface (power_supply_interface.c)         │
│  • power_supply_get_int_property_value()               │
│  • power_supply_set_int_property_value()               │
│  • power_supply_sync_changed()                         │
│  作用：封装标准power_supply接口，简化调用               │
└────────────────────┬────────────────────────────────────┘
                     │
┌────────────────────┴────────────────────────────────────┐
│  Layer 1: Core (power_supply.c)                        │
│  • power_supply_ops_register()                         │
│  • power_supply_battery_get_property()                 │
│  • power_supply_register_power_supply()                │
│  作用：核心适配层，连接Linux框架和硬件驱动               │
└─────────────────────────────────────────────────────────┘
```

### 2.2 核心数据流
```
┌─────────────────────────────────────────────────────────┐
│  读取电池电量流程示例                                     │
└─────────────────────────────────────────────────────────┘

1. Android层读取
   cat /sys/class/power_supply/Battery/capacity
        ↓
2. Linux power_supply框架
   power_supply_show_property()
        ↓
3. power_supply核心层
   power_supply_cust_bat_get_property(POWER_SUPPLY_PROP_CAPACITY)
        ↓
4. 根据属性类型调用
   power_supply_get_capacity_property(POWER_SUPPLY_PROP_BAT)
        ↓
5. 查找已注册的ops
   power_supply_get_ops(POWER_SUPPLY_PROP_BAT)
        ↓
6. 调用底层驱动回调
   l_ops->get_capacity_prop()  // 由coul驱动注册
        ↓
7. 返回电量值
   return 85;  // 85%
```

---

## 3. 核心数据结构

### 3.1 电源操作接口（power_supply_ops）
```c
struct power_supply_ops {
    const char *type_name;  // 类型名称："bat"/"usb"/"wireless"等
    
    // 状态相关属性（20+回调函数）
    int (*get_status_prop)(void);          // 充电状态
    int (*get_health_prop)(void);          // 健康状态
    int (*get_present_prop)(void);         // 是否在位
    int (*get_online_prop)(void);          // 是否在线
    int (*get_technology_prop)(void);      // 电池技术类型
    
    // 温度和循环
    int (*get_temp_prop)(void);            // 温度
    int (*get_cycle_count_prop)(void);     // 循环次数
    int (*get_limit_fcc_prop)(void);       // FCC限制
    
    // 电压相关
    int (*get_voltage_now_prop)(void);     // 当前电压
    int (*get_voltage_max_prop)(void);     // 最大电压
    int (*get_voltage_max_design_prop)(void); // 设计最大电压
    int (*set_voltage_max_prop)(int value); // 设置最大电压（可写）
    
    // 电流相关
    int (*get_current_now_prop)(void);     // 当前电流
    int (*get_current_max_prop)(void);     // 最大电流
    int (*get_current_avg_prop)(void);     // 平均电流
    int (*get_input_current_limit_prop)(void); // 输入电流限制
    int (*set_input_current_limit_prop)(int value); // 设置输入限流
    
    // 容量相关
    int (*get_capacity_prop)(void);        // 百分比电量
    int (*get_capacity_level_prop)(void);  // 电量等级
    int (*get_capacity_rm_prop)(void);     // 剩余容量(mAh)
    int (*get_capacity_fcc_prop)(void);    // 满充容量(mAh)
    
    // 充电量相关
    int (*get_charge_full_prop)(void);     // 充满电量
    int (*get_charge_counter_prop)(void);  // 电量计数器
    int (*get_charge_full_design_prop)(void); // 设计容量
    int (*get_charge_now_prop)(void);      // 当前电量
    
    // 其他
    int (*get_batid_prop)(void);           // 电池ID
    const char *(*get_brand_prop)(void);   // 电池品牌
    int (*get_type_prop)(void);            // 类型
    int (*get_usb_type_prop)(void);        // USB类型
};
```

**设计说明**：
- 所有回调函数均为可选，未实现时返回默认值
- 采用函数指针表避免大量if-else判断
- 支持读写分离（部分属性可写）

### 3.2 电源设备管理结构（power_supply_dev）
```c
struct power_supply_dev {
    struct device *dev;               // 平台设备
    struct device_node *np;           // DTS节点
    
    // 6种power_supply实例
    struct power_supply *bat;         // 主电池 (Battery)
    struct power_supply *raw_bat;     // 原始电池 (battery/huawei_batt)
    struct power_supply *assist_bat;  // 辅助电池 (assist_battery)
    struct power_supply *mains;       // 市电 (Mains)
    struct power_supply *usb;         // USB充电 (usb/USB)
    struct power_supply *wireless;    // 无线充电 (Wireless)
    
    // 配置标志（通过DTS配置）
    int support_bat;                  // 是否支持主电池（默认1）
    int support_raw_bat;              // 是否支持原始电池（默认0）
    int support_assist_bat;           // 是否支持辅助电池（默认0）
    int support_mains;                // 是否支持市电（默认0）
    int support_usb;                  // 是否支持USB（默认0）
    int support_wireless;             // 是否支持无线充电（默认0）
    
    enum power_supply_bat_mode bat_mode; // 电池模式
    unsigned int total_ops;           // 已注册的ops数量
    struct power_supply_ops *p_ops[POWER_SUPPLY_PROP_END]; // ops数组
};
```

**bat_mode说明**：
- `POWER_SUPPLY_BAT_REGIST_MODE`：正常模式，使用注册的ops
- `POWER_SUPPLY_BAT_BYPASS_MODE`：透传模式，直接读取"battery"节点

### 3.3 电源类型枚举
```c
enum power_supply_prop_type {
    POWER_SUPPLY_PROP_BEGIN = 0,
    POWER_SUPPLY_PROP_BAT = 0,        // 主电池（自定义逻辑）
    POWER_SUPPLY_PROP_RAW_BAT,        // 原始电池（底层真实数据）
    POWER_SUPPLY_PROP_ASSITST_BAT,    // 辅助电池（双电池方案）
    POWER_SUPPLY_PROP_MAINS,          // 市电（AC充电器）
    POWER_SUPPLY_PROP_USB,            // USB充电
    POWER_SUPPLY_PROP_WIRELESS,       // 无线充电
    POWER_SUPPLY_PROP_END,
};
```

**类型说明**：
- **BAT vs RAW_BAT**：BAT用于对外展示（可能经过处理），RAW_BAT是底层真实数据
- **ASSIST_BAT**：用于双电池折叠屏方案（MATE X5有两块电池）

---

## 4. 核心功能实现

### 4.1 驱动注册接口
```c
int power_supply_ops_register(struct power_supply_ops *ops)
{
    int type;
    
    // 1. 参数检查
    if (!g_power_supply_dev || !ops || !ops->type_name)
        return -EPERM;

    // 2. 根据类型名查找类型ID
    type = power_supply_get_prop_type(ops->type_name);
    // "bat" -> POWER_SUPPLY_PROP_BAT
    // "usb" -> POWER_SUPPLY_PROP_USB
    
    if (type < 0)
        return -EPERM;

    // 3. 注册到全局ops数组
    g_power_supply_dev->p_ops[type] = ops;
    g_power_supply_dev->total_ops++;

    hwlog_info("total_ops=%d type=%d:%s ops register ok\n",
        g_power_supply_dev->total_ops, type, ops->type_name);
    return 0;
}
```

**使用示例（在coul驱动中）**：
```c
static int coul_get_capacity(void)
{
    return coul_drv_battery_capacity();  // 读取电量计数据
}

static int coul_get_voltage_now(void)
{
    return coul_drv_battery_voltage();
}

static struct power_supply_ops coul_bat_ops = {
    .type_name = "bat",
    .get_capacity_prop = coul_get_capacity,
    .get_voltage_now_prop = coul_get_voltage_now,
    .get_temp_prop = coul_get_temp,
    // ... 其他回调
};

static int coul_probe(struct platform_device *pdev)
{
    // ...
    power_supply_ops_register(&coul_bat_ops);  // 注册电池ops
    return 0;
}
```

### 4.2 属性读取流程
```c
static int power_supply_cust_bat_get_property(struct power_supply *psy,
    enum power_supply_property psp, union power_supply_propval *val)
{
    struct power_supply_dev *l_dev = power_supply_get_dev();

    // 如果是透传模式，直接读取底层battery节点
    if (l_dev->bat_mode == POWER_SUPPLY_BAT_BYPASS_MODE)
        return power_supply_get_property_value("battery", psp, val);

    // 否则调用注册的回调
    return power_supply_battery_get_property(POWER_SUPPLY_PROP_BAT,
        psp, val);
}

static int power_supply_battery_get_property(int type,
    enum power_supply_property psp, union power_supply_propval *val)
{
    switch (psp) {
    case POWER_SUPPLY_PROP_CAPACITY:
        // 1. 获取已注册的ops
        struct power_supply_ops *l_ops = power_supply_get_ops(type);
        
        // 2. 检查回调是否存在
        if (!l_ops || !l_ops->get_capacity_prop)
            return POWER_SUPPLY_DEFAULT_CAPACITY;  // 返回默认值50
        
        // 3. 调用底层驱动回调
        val->intval = l_ops->get_capacity_prop();
        break;
    
    // ... 其他22个属性的处理
    }
    return 0;
}
```

### 4.3 电源设备注册
```c
static int power_supply_register_power_supply(struct power_supply_dev *l_dev)
{
    // 根据DTS配置注册不同的power_supply设备
    
    if (l_dev->support_bat) {
        l_dev->bat = power_supply_register(l_dev->dev,
            &power_supply_battery_desc, NULL);
        // 注册 /sys/class/power_supply/Battery
    }

    if (l_dev->support_raw_bat) {
        l_dev->raw_bat = power_supply_register(l_dev->dev,
            &power_supply_raw_battery_desc, NULL);
        // 注册 /sys/class/power_supply/battery 或 huawei_batt
    }

    if (l_dev->support_usb) {
        l_dev->usb = power_supply_register(l_dev->dev,
            &power_supply_usb_desc, NULL);
        // 注册 /sys/class/power_supply/usb
    }

    // ... 类似处理 assist_bat/mains/wireless
    
    return 0;
}
```

**结果**：创建sysfs节点
```
/sys/class/power_supply/
├── Battery/          # 主电池（Android读取此节点）
│   ├── capacity      # 电量百分比
│   ├── voltage_now   # 当前电压
│   ├── current_now   # 当前电流
│   ├── temp          # 温度
│   └── status        # 充电状态
├── battery/          # 原始电池（调试用）
├── assist_battery/   # 辅助电池（双电池）
├── usb/              # USB充电器
│   ├── online        # 是否在线
│   ├── voltage_now   # USB电压
│   └── usb_type      # USB类型(SDP/DCP/PD等)
└── Wireless/         # 无线充电
    └── online
```

### 4.4 辅助接口层（power_supply_interface.c）
```c
// 简化的整数属性读取
int power_supply_get_int_property_value(const char *name,
    enum power_supply_property psp, int *val)
{
    union power_supply_propval union_val = { 0 };
    
    // 1. 根据名称获取power_supply实例
    // 2. 调用标准get_property
    // 3. 提取整数值
    
    ret = power_supply_get_property_value(name, psp, &union_val);
    if (!ret)
        *val = union_val.intval;
    
    return ret;
}

// 使用示例
int capacity;
power_supply_get_int_property_value("Battery", 
    POWER_SUPPLY_PROP_CAPACITY, &capacity);
// capacity = 85
```

### 4.5 应用层接口（power_supply_application.c）
```c
int power_supply_app_get_bat_capacity(void)
{
    struct power_supply_app_dev *l_dev = power_supply_app_get_dev();
    int val = POWER_SUPPLY_DEFAULT_CAPACITY;
    
    // 从DTS配置的电池节点名读取（默认"battery"）
    ret = power_supply_get_int_property_value(l_dev->bat_psy,
        POWER_SUPPLY_PROP_CAPACITY, &val);
    
    if (ret)
        hwlog_err("use default bat_capacity: value=%d\n", val);
    
    return val;
}

// 其他内核模块直接调用
#include <chipset_common/hwpower/common_module/power_supply_application.h>

int capacity = power_supply_app_get_bat_capacity();
int temp = power_supply_app_get_bat_temp();
int vbat = power_supply_app_get_bat_voltage_now();
```

**优势**：
- 隐藏power_supply框架复杂性
- 提供类型安全的接口
- 自动处理单位转换（如温度÷10）
- 内置默认值处理

---

## 5. 支持的属性列表

### 5.1 电池属性（23个）
| 属性名 | 类型 | 说明 | 默认值 |
|-------|------|------|--------|
| `POWER_SUPPLY_PROP_STATUS` | int | 充电状态 | 1 (UNKNOWN) |
| `POWER_SUPPLY_PROP_HEALTH` | int | 健康状态 | UNKNOWN |
| `POWER_SUPPLY_PROP_PRESENT` | int | 是否在位 | 1 |
| `POWER_SUPPLY_PROP_ONLINE` | int | 是否在线 | 1 |
| `POWER_SUPPLY_PROP_TECHNOLOGY` | int | 电池技术 | UNKNOWN |
| `POWER_SUPPLY_PROP_TEMP` | int | 温度(0.1°C) | 250 (25°C) |
| `POWER_SUPPLY_PROP_CYCLE_COUNT` | int | 循环次数 | 1 |
| `POWER_SUPPLY_PROP_LIMIT_FCC` | int | FCC限制(mA) | 4000 |
| `POWER_SUPPLY_PROP_VOLTAGE_NOW` | int | 当前电压(uV) | 4000000 (4.0V) |
| `POWER_SUPPLY_PROP_VOLTAGE_MAX` | int | 最大电压(uV) | 4400000 (4.4V) |
| `POWER_SUPPLY_PROP_VOLTAGE_MAX_DESIGN` | int | 设计电压 | 4400000 |
| `POWER_SUPPLY_PROP_CURRENT_NOW` | int | 当前电流(uA) | 470000 (470mA) |
| `POWER_SUPPLY_PROP_CURRENT_AVG` | int | 平均电流 | 470000 |
| `POWER_SUPPLY_PROP_CAPACITY` | int | 电量百分比 | 50 |
| `POWER_SUPPLY_PROP_CAPACITY_LEVEL` | int | 电量等级 | NORMAL |
| `POWER_SUPPLY_PROP_CAPACITY_RM` | int | 剩余容量(mAh) | 2000 |
| `POWER_SUPPLY_PROP_CAPACITY_FCC` | int | 满充容量(mAh) | 4000 |
| `POWER_SUPPLY_PROP_CHARGE_FULL` | int | 充满电量(uAh) | 4000000 |
| `POWER_SUPPLY_PROP_CHARGE_COUNTER` | int | 电量计数 | 3500000 |
| `POWER_SUPPLY_PROP_CHARGE_FULL_DESIGN` | int | 设计容量 | 4000000 |
| `POWER_SUPPLY_PROP_CHARGE_NOW` | int | 当前电量(uAh) | 2000000 |
| `POWER_SUPPLY_PROP_ID_VOLTAGE` | int | 电池ID电压(mV) | 200 |
| `POWER_SUPPLY_PROP_BRAND` | str | 电池品牌 | "default" |

### 5.2 USB属性（8个，内核5.4+）
| 属性名 | 类型 | 说明 | 默认值 |
|-------|------|------|--------|
| `POWER_SUPPLY_PROP_ONLINE` | int | 是否在线 | 0 |
| `POWER_SUPPLY_PROP_VOLTAGE_NOW` | int | USB电压 | 0 |
| `POWER_SUPPLY_PROP_VOLTAGE_MAX` | int | 最大电压 | 0 |
| `POWER_SUPPLY_PROP_CURRENT_NOW` | int | 当前电流 | 0 |
| `POWER_SUPPLY_PROP_CURRENT_MAX` | int | 最大电流 | 500000 (500mA) |
| `POWER_SUPPLY_PROP_INPUT_CURRENT_LIMIT` | int | 输入限流(可写) | 500000 |
| `POWER_SUPPLY_PROP_USB_TYPE` | int | USB类型 | 0 |
| `POWER_SUPPLY_PROP_TEMP` | int | 充电器温度 | 250 |

**支持的USB类型**：
- `POWER_SUPPLY_USB_TYPE_SDP`：标准USB (5V 500mA)
- `POWER_SUPPLY_USB_TYPE_DCP`：专用充电器 (5V 1.5A)
- `POWER_SUPPLY_USB_TYPE_CDP`：充电数据端口
- `POWER_SUPPLY_USB_TYPE_PD`：USB Power Delivery
- `POWER_SUPPLY_USB_TYPE_PD_PPS`：PD PPS (可编程电源)

---

## 6. 典型使用场景

### 6.1 场景1：底层驱动注册电池属性
```c
// 在coul_core.c中
static int coul_get_bat_capacity(void)
{
    return coul_battery_capacity();  // 从电量计芯片读取
}

static int coul_get_bat_voltage(void)
{
    return coul_battery_voltage_uv();  // 单位：uV
}

static int coul_get_bat_current(void)
{
    return coul_battery_current_ua();  // 单位：uA
}

static int coul_get_bat_temp(void)
{
    return coul_battery_temperature();  // 单位：0.1°C
}

static struct power_supply_ops coul_bat_ops = {
    .type_name = "bat",  // 注册为主电池
    .get_capacity_prop = coul_get_bat_capacity,
    .get_voltage_now_prop = coul_get_bat_voltage,
    .get_current_now_prop = coul_get_bat_current,
    .get_temp_prop = coul_get_bat_temp,
    .get_health_prop = coul_get_bat_health,
    .get_status_prop = coul_get_charge_status,
    // ... 其他属性
};

static int coul_probe(struct platform_device *pdev)
{
    int ret;
    
    // 初始化电量计硬件
    ret = coul_hardware_init();
    if (ret)
        return ret;
    
    // 注册到power_supply框架
    ret = power_supply_ops_register(&coul_bat_ops);
    if (ret)
        hwlog_err("register bat ops fail\n");
    
    return ret;
}
```

### 6.2 场景2：充电器驱动注册USB属性
```c
// 在charger.c中
static int charger_get_usb_online(void)
{
    return charge_get_charger_online();  // 检测充电器是否插入
}

static int charger_get_usb_voltage(void)
{
    return charge_get_vbus();  // 读取VBUS电压
}

static int charger_get_usb_type(void)
{
    int type = charge_get_charger_type();
    
    // 转换为标准USB类型
    switch (type) {
    case CHARGER_TYPE_SDP:
        return POWER_SUPPLY_USB_TYPE_SDP;
    case CHARGER_TYPE_DCP:
        return POWER_SUPPLY_USB_TYPE_DCP;
    case CHARGER_TYPE_PD:
        return POWER_SUPPLY_USB_TYPE_PD;
    default:
        return POWER_SUPPLY_USB_TYPE_UNKNOWN;
    }
}

static int charger_set_input_current_limit(int value)
{
    return charge_set_input_current(value / 1000);  // uA -> mA
}

static struct power_supply_ops charger_usb_ops = {
    .type_name = "usb",
    .get_online_prop = charger_get_usb_online,
    .get_voltage_now_prop = charger_get_usb_voltage,
    .get_usb_type_prop = charger_get_usb_type,
    .set_input_current_limit_prop = charger_set_input_current_limit,
};

static int charger_probe(struct platform_device *pdev)
{
    // ...
    power_supply_ops_register(&charger_usb_ops);
    return 0;
}
```

### 6.3 场景3：Android应用读取电池信息
```bash
# Android层通过sysfs读取

# 读取电量
adb shell cat /sys/class/power_supply/Battery/capacity
# 输出：85

# 读取电压
adb shell cat /sys/class/power_supply/Battery/voltage_now
# 输出：4200000  (4.2V，单位uV)

# 读取温度
adb shell cat /sys/class/power_supply/Battery/temp
# 输出：350  (35°C，单位0.1°C)

# 读取充电状态
adb shell cat /sys/class/power_supply/Battery/status
# 输出：Charging / Discharging / Full / Not charging

# 读取USB类型
adb shell cat /sys/class/power_supply/usb/usb_type
# 输出：USB_PD  (支持PD快充)
```

### 6.4 场景4：内核模块使用应用层接口
```c
// 在无线充电驱动中
#include <chipset_common/hwpower/common_module/power_supply_application.h>

static void wldc_check_battery_state(void)
{
    int capacity, temp, vbat;
    
    // 使用简化接口读取电池信息
    capacity = power_supply_app_get_bat_capacity();
    temp = power_supply_app_get_bat_temp();  // 自动转换为°C
    vbat = power_supply_app_get_bat_voltage_now();  // 自动转换为mV
    
    hwlog_info("battery: capacity=%d%%, temp=%d°C, vbat=%dmV\n",
        capacity, temp, vbat);
    
    // 根据电池状态调整无线充电功率
    if (temp > 45)
        wldc_set_power_limit(50);  // 高温降功率
    else if (capacity > 90)
        wldc_set_power_limit(30);  // 接近充满降功率
}
```

### 6.5 场景5：DTS配置示例
```dts
// 设备树配置
power_supply: power_supply {
    compatible = "huawei,power_supply";
    
    // 配置启用的电源类型
    support_bat = <1>;         // 启用主电池
    support_raw_bat = <0>;     // 禁用原始电池
    support_assist_bat = <1>;  // 启用辅助电池（双电池）
    support_mains = <0>;       // 禁用市电
    support_usb = <1>;         // 启用USB
    support_wireless = <1>;    // 启用无线充电
    
    // 电池模式
    bat_mode = <0>;  // 0=注册模式, 1=透传模式
};

power_supply_app: power_supply_app {
    compatible = "huawei,power_supply_app";
    
    // 配置电池节点名（平台相关）
    bat_psy_name = "battery";  // 或 "Battery"
    usb_psy_name = "usb";      // 或 "USB"
};
```

---

## 7. 调试方法

### 7.1 检查注册状态
```bash
# 查看已注册的power_supply设备
ls /sys/class/power_supply/
# 期望输出：Battery  battery  assist_battery  usb  Wireless

# 查看设备类型
cat /sys/class/power_supply/Battery/type
# 输出：Battery

cat /sys/class/power_supply/usb/type
# 输出：USB

# 检查内核日志
dmesg | grep "power_psy\|power_supply"
# 期望输出：
# [   10.123] power_psy: total_ops=1 type=0:bat ops register ok
# [   10.234] power_psy: total_ops=2 type=4:usb ops register ok
# [   10.345] power_psy: total_ops=3 type=5:wireless ops register ok
```

### 7.2 测试属性读取
```bash
# 批量读取所有电池属性
cd /sys/class/power_supply/Battery
for prop in *; do
    echo "=== $prop ==="
    cat "$prop" 2>&1
done

# 输出示例：
# === capacity ===
# 85
# === voltage_now ===
# 4200000
# === current_now ===
# -500000  (负数表示放电)
# === temp ===
# 350  (35°C)
# === status ===
# Charging
```

### 7.3 测试属性写入
```bash
# 设置USB输入限流（需要内核5.4+）
echo 1000000 > /sys/class/power_supply/usb/input_current_limit
# 限制输入电流为1A

# 设置辅助电池最大电压
echo 4350000 > /sys/class/power_supply/assist_battery/voltage_max
# 设置为4.35V

# 检查是否生效
cat /sys/class/power_supply/usb/input_current_limit
# 输出：1000000
```

### 7.4 调试回调函数
```c
// 在驱动中添加调试信息
static int coul_get_bat_capacity(void)
{
    int capacity = coul_battery_capacity();
    
    // 添加详细日志
    hwlog_info("[PSY_DEBUG] get_capacity called, value=%d\n", capacity);
    
    return capacity;
}

// 查看调用日志
dmesg -w | grep PSY_DEBUG
# [  123.456] coul: [PSY_DEBUG] get_capacity called, value=85
```

### 7.5 常见问题排查

| 问题现象 | 可能原因 | 排查方法 |
|---------|---------|---------|
| `/sys/class/power_supply/Battery` 不存在 | power_supply模块未加载 | `dmesg \| grep power_supply` 检查是否probe成功 |
| `cat capacity` 返回50（默认值） | ops未注册或回调未实现 | 检查 `total_ops` 日志，确认驱动已注册 |
| `cat voltage_now` 显示固定值不变 | 回调函数返回常量 | 在回调中加日志，确认硬件读取正常 |
| Android无法读取电量 | 节点名称不匹配 | Android期望 `Battery`，检查desc.name |
| `echo xxx > input_current_limit` 失败 | 属性不可写或权限不足 | 检查 `property_is_writeable` 实现 |
| 双电池显示不正确 | assist_battery未启用 | DTS中设置 `support_assist_bat=1` |

---

## 8. 与其他模块的交互

### 8.1 依赖关系
```
power_supply 模块依赖：
├── Linux power_supply框架  --> 标准内核接口
├── power_dts.h            --> DTS解析
├── power_event_ne.h       --> 事件通知（可选）
└── power_printk.h         --> 日志打印
```

### 8.2 被依赖关系
**几乎所有电源相关模块**都依赖power_supply：

1. **电量计驱动（coul）**
   - 注册 `bat` 类型ops
   - 提供电压/电流/容量/温度读取

2. **充电器驱动（charger）**
   - 注册 `usb` 类型ops
   - 提供充电器在线状态、VBUS电压、USB类型
   - 支持输入限流设置

3. **无线充电驱动（wireless_charger）**
   - 注册 `wireless` 类型ops
   - 提供无线充电在线状态

4. **直充驱动（direct_charge）**
   - 读取电池电压/电流用于控制
   - 通过 `power_supply_app_get_bat_voltage_now()` 获取

5. **电池健康管理（battery_health）**
   - 读取循环次数、温度、电压
   - 评估电池健康状态

### 8.3 与Android Framework的交互
```
┌─────────────────────────────────────────────────────┐
│  Android Java层 (BatteryService)                   │
│  frameworks/base/services/core/java/com/android/   │
│  server/BatteryService.java                        │
└────────────────────┬────────────────────────────────┘
                     │ JNI
┌────────────────────┴────────────────────────────────┐
│  Android Native层 (BatteryMonitor)                 │
│  system/core/healthd/BatteryMonitor.cpp            │
│  读取 /sys/class/power_supply/Battery/*            │
└────────────────────┬────────────────────────────────┘
                     │ sysfs
┌────────────────────┴────────────────────────────────┐
│  Linux power_supply框架                             │
│  drivers/power/supply/power_supply_sysfs.c         │
└────────────────────┬────────────────────────────────┘
                     │ get_property()
┌────────────────────┴────────────────────────────────┐
│  power_supply模块 (适配层)                          │
│  drivers/hwpower/cc_common_module/power_supply/    │
└────────────────────┬────────────────────────────────┘
                     │ ops回调
┌────────────────────┴────────────────────────────────┐
│  coul/charger等硬件驱动                             │
└─────────────────────────────────────────────────────┘
```

**Android读取的关键属性**：
- `capacity`：电量百分比（状态栏显示）
- `status`：充电状态（Charging图标）
- `health`：健康状态（过热/过冷警告）
- `temp`：温度（过热保护）
- `voltage_now`：电压（电池设置中显示）
- `technology`：电池技术类型（锂离子/锂聚合物）

---

## 9. 关键设计细节

### 9.1 为何需要BAT和RAW_BAT两种电池类型
**设计原因**：
1. **RAW_BAT**：底层真实数据，用于工厂测试和调试
   - 直接从硬件读取，无任何修正
   - 节点名 `battery` 或 `huawei_batt`

2. **BAT**：对外展示数据，用于Android显示
   - 可能经过平滑处理（避免跳变）
   - 可能应用电量修正算法
   - 节点名 `Battery`（Android标准）

**实际案例**：
```
RAW_BAT读取：capacity = 87%  (硬件返回值)
BAT显示：   capacity = 85%  (应用平滑算法后)
```

### 9.2 为何需要ASSIST_BAT辅助电池
**硬件背景**：MATE X5折叠屏采用**双电池方案**
```
┌──────────────┐
│   主屏幕     │  ← 主电池 (4000mAh)
├──────────────┤
│   副屏幕     │  ← 辅助电池 (4000mAh)
└──────────────┘
总容量：8000mAh
```

**软件实现**：
- **BAT**：显示合并后的总电量（85%）
- **ASSIST_BAT**：单独显示辅助电池状态（用于均衡充电）

### 9.3 为何USB属性在内核5.4前后不同
**Linux 5.4内核重大变更**：
- **5.4之前**：USB只有 `online` 一个属性
- **5.4之后**：新增 `usb_type`、`input_current_limit` 等

**兼容性处理**：
```c
#if (LINUX_VERSION_CODE >= KERNEL_VERSION(5, 4, 0))
    // 新版本：支持完整USB属性
    static enum power_supply_property power_supply_usb_props[] = {
        POWER_SUPPLY_PROP_ONLINE,
        POWER_SUPPLY_PROP_VOLTAGE_NOW,
        POWER_SUPPLY_PROP_USB_TYPE,  // 新增
        POWER_SUPPLY_PROP_INPUT_CURRENT_LIMIT,  // 新增（可写）
        // ...
    };
#else
    // 旧版本：仅支持online
    static enum power_supply_property power_supply_usb_props[] = {
        POWER_SUPPLY_PROP_ONLINE,
    };
#endif
```

### 9.4 为何需要三层架构
**分层理由**：

| 层级 | 职责 | 优势 |
|-----|------|------|
| **Application** | 简化接口 | 其他模块无需了解power_supply框架 |
| **Interface** | 辅助函数 | 自动处理union/指针，减少重复代码 |
| **Core** | 核心适配 | 连接Linux标准和华为实现 |

**对比传统方式**：
```c
// 传统方式（复杂）
struct power_supply *psy;
union power_supply_propval val;
psy = power_supply_get_by_name("Battery");
power_supply_get_property(psy, POWER_SUPPLY_PROP_CAPACITY, &val);
int capacity = val.intval;
power_supply_put(psy);

// 应用层接口（简化）
int capacity = power_supply_app_get_bat_capacity();
```

---

## 10. 最佳实践建议

### 10.1 驱动开发者
1. **完整实现ops回调**：
   ```c
   // 推荐：实现所有相关属性
   static struct power_supply_ops coul_bat_ops = {
       .type_name = "bat",
       .get_capacity_prop = coul_get_capacity,      // 必须
       .get_voltage_now_prop = coul_get_voltage,    // 必须
       .get_current_now_prop = coul_get_current,    // 必须
       .get_temp_prop = coul_get_temp,              // 必须
       .get_status_prop = coul_get_status,          // 推荐
       .get_health_prop = coul_get_health,          // 推荐
       .get_cycle_count_prop = coul_get_cycles,     // 可选
       .get_brand_prop = coul_get_brand,            // 可选
       // ...
   };
   
   // 避免：只实现部分属性（Android可能读取失败）
   ```

2. **注意单位转换**：
   ```c
   // 电压：必须返回 uV（微伏）
   static int get_voltage_now(void)
   {
       int mv = read_voltage_from_hardware();
       return mv * 1000;  // mV -> uV
   }
   
   // 电流：必须返回 uA（微安）
   static int get_current_now(void)
   {
       int ma = read_current_from_hardware();
       return ma * 1000;  // mA -> uA
   }
   
   // 温度：必须返回 0.1°C
   static int get_temp(void)
   {
       int celsius = read_temp_from_hardware();
       return celsius * 10;  // °C -> 0.1°C
   }
   ```

3. **错误处理**：
   ```c
   static int get_voltage_now(void)
   {
       int ret, voltage;
       
       ret = i2c_read_voltage(&voltage);
       if (ret) {
           hwlog_err("read voltage fail, ret=%d\n", ret);
           return POWER_SUPPLY_DEFAULT_VOLTAGE_NOW;  // 返回默认值
       }
       
       return voltage * 1000;
   }
   ```

### 10.2 平台集成者
1. **DTS配置建议**：
   ```dts
   // 标准Android设备
   power_supply {
       support_bat = <1>;        // 必须
       support_usb = <1>;        // 推荐
       support_wireless = <1>;   // 如果支持无线充电
       bat_mode = <0>;           // 注册模式
   };
   
   // 双电池折叠屏
   power_supply {
       support_bat = <1>;
       support_assist_bat = <1>;  // 启用辅助电池
       support_usb = <1>;
   };
   ```

2. **确保初始化顺序**：
   ```c
   // power_supply必须在硬件驱动之前初始化
   fs_initcall_sync(power_supply_init);        // 最早
   device_initcall(coul_init);                 // 之后
   late_initcall(charger_init);                // 更晚
   ```

### 10.3 应用开发者
1. **优先使用application接口**：
   ```c
   // 推荐：使用封装好的接口
   #include <chipset_common/hwpower/common_module/power_supply_application.h>
   
   int capacity = power_supply_app_get_bat_capacity();  // 直接获取
   
   // 不推荐：直接操作power_supply（除非必要）
   struct power_supply *psy = power_supply_get_by_name("Battery");
   // ... 复杂操作
   ```

2. **处理默认值**：
   ```c
   int capacity = power_supply_app_get_bat_capacity();
   if (capacity == POWER_SUPPLY_DEFAULT_CAPACITY) {
       hwlog_warn("battery capacity unavailable\n");
       // 使用备用方案
   }
   ```

---

## 11. 性能优化建议

### 11.1 避免频繁读取
```c
// 不推荐：在循环中频繁读取
for (i = 0; i < 1000; i++) {
    int vbat = power_supply_app_get_bat_voltage_now();
    // 每次都触发I2C读取
}

// 推荐：缓存读取结果
static int g_cached_vbat;
static unsigned long g_cache_time;

int get_bat_voltage_cached(void)
{
    unsigned long now = jiffies;
    
    // 100ms内使用缓存值
    if (time_before(now, g_cache_time + msecs_to_jiffies(100)))
        return g_cached_vbat;
    
    g_cached_vbat = power_supply_app_get_bat_voltage_now();
    g_cache_time = now;
    return g_cached_vbat;
}
```

### 11.2 使用批量读取
```c
// 推荐：一次读取多个属性（减少锁竞争）
struct power_supply *psy = power_supply_get_by_name("Battery");
union power_supply_propval val;

power_supply_get_property_value_with_psy(psy, POWER_SUPPLY_PROP_CAPACITY, &val);
int capacity = val.intval;

power_supply_get_property_value_with_psy(psy, POWER_SUPPLY_PROP_VOLTAGE_NOW, &val);
int voltage = val.intval;

power_supply_put(psy);
```

---

## 12. 总结

### 12.1 核心特性
| 特性 | 说明 |
|-----|------|
| **多电源支持** | 同时管理6种电源类型（电池/充电器/无线） |
| **标准适配** | 连接Linux power_supply框架和华为驱动 |
| **回调机制** | 通过ops注册实现驱动解耦 |
| **三层架构** | Core + Interface + Application分层设计 |
| **灵活配置** | DTS配置启用/禁用特定电源 |
| **双电池支持** | 为折叠屏提供辅助电池管理 |

### 12.2 价值体现
1. **统一接口**：所有电源属性通过标准sysfs访问
2. **简化开发**：应用层接口隐藏框架复杂性
3. **兼容性**：支持内核5.4前后版本
4. **扩展性**：新增电源类型只需注册ops
5. **Android兼容**：完全兼容Android BatteryService

### 12.3 模块定位总结
```
华为电源管理子系统模块定位：

基础设施层：
├── power_sysfs      --> sysfs节点管理
├── power_supply     --> 电源设备抽象 ← 当前模块
├── power_event      --> 事件通知
├── power_vote       --> 参数仲裁
├── power_dsm        --> 异常上报
└── power_log        --> 日志收集

业务功能层：
├── coul             --> 电量计驱动（注册bat ops）
├── charger          --> 充电器驱动（注册usb ops）
├── wireless_charger --> 无线充电（注册wireless ops）
└── direct_charge    --> 直充驱动（读取bat属性）
```

**power_supply的关键作用**：
- 作为**电源设备的统一抽象层**
- 连接**Linux标准框架**和**华为硬件驱动**
- 为**Android系统**提供**标准电源信息接口**
