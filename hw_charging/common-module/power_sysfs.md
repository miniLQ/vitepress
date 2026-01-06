---
outline: deep
---

# Power Sysfs 模块

## 1. 模块定位与核心价值

### 1.1 模块定位
**power_sysfs** 是华为MATE X5电源管理子系统的**sysfs基础设施层**，为所有电源模块提供**统一的sysfs节点创建和管理服务**。它是整个电源管理子系统与用户空间交互的**基础框架**。

### 1.2 核心价值
1. **统一的节点管理**：集中管理所有电源相关的sysfs类（class）和设备（device）
2. **简化驱动开发**：提供便捷的宏和辅助函数，减少重复代码
3. **规范化路径**：确保所有电源节点遵循一致的目录结构
4. **生命周期管理**：自动处理设备节点的创建、查找和销毁
5. **符号链接支持**：支持在不同设备间创建软链接，便于访问

### 1.3 典型sysfs路径结构
```
/sys/class/
├── hw_power/              # 主电源管理类
│   ├── charger/           # 充电器设备
│   ├── vsys_switch/       # 系统电源切换
│   ├── coul/              # 库仑计设备
│   ├── battery/           # 电池设备
│   └── power_log/         # 日志设备（前一个分析的模块）
├── hw_typec/              # Type-C类
├── hw_usb/                # USB类
├── hishow/                # 显示类
└── hw_accessory/          # 配件类
```

---

## 2. 系统架构

### 2.1 整体架构图
```
┌─────────────────────────────────────────────────────────────┐
│                      Userspace                              │
│  /sys/class/hw_power/charger/iin_thermal                    │
│  /sys/class/hw_power/battery/capacity                       │
│  /sys/class/hw_power/power_log/content                      │
└────────────────────────┬────────────────────────────────────┘
                         │ sysfs VFS layer
┌────────────────────────┴────────────────────────────────────┐
│                  power_sysfs Framework                      │
│  ┌──────────────┐  ┌──────────────┐  ┌──────────────┐     │
│  │ Class        │  │ Device       │  │ Attribute    │     │
│  │ Manager      │  │ Manager      │  │ Helper       │     │
│  └──────────────┘  └──────────────┘  └──────────────┘     │
│  • 5 Pre-defined Classes                                    │
│  • 4 Pre-defined Devices under hw_power                     │
│  • Macro-based attribute definition                         │
└────────────────────────┬────────────────────────────────────┘
                         │ API calls
┌────────────────────────┴────────────────────────────────────┐
│              Power Module Drivers                           │
│  ┌────────────┐  ┌────────────┐  ┌────────────┐           │
│  │ power_log  │  │ charger    │  │ battery    │  ...      │
│  │ driver     │  │ driver     │  │ driver     │           │
│  └────────────┘  └────────────┘  └────────────┘           │
│   create_group()   create_group()  create_link_group()     │
└─────────────────────────────────────────────────────────────┘
```

### 2.2 设计理念
- **集中式管理**：所有class和device在模块初始化时统一创建
- **查找即用**：驱动程序无需创建class/device，只需查找并添加属性
- **宏简化定义**：通过宏自动生成属性定义，减少样板代码
- **分层设计**：Class → Device → Attribute Group 三级结构

---

## 3. 核心数据结构

### 3.1 设备数据结构
```c
struct power_sysfs_device_data {
    const char *name;        // 设备名称（如"charger"）
    struct device *entity;   // 内核device结构指针
};
```

**用途**：描述一个sysfs设备节点，如 `/sys/class/hw_power/charger`

### 3.2 类数据结构
```c
struct power_sysfs_class_data {
    const char *name;                           // 类名（如"hw_power"）
    struct class *entity;                       // 内核class结构指针
    struct power_sysfs_device_data *dev_data;   // 设备列表
    int dev_size;                               // 设备数量
};
```

**用途**：描述一个sysfs类及其下属设备

### 3.3 属性信息结构
```c
struct power_sysfs_attr_info {
    struct device_attribute attr;  // 标准内核属性
    u8 name;                       // 自定义类型ID（用于switch-case）
};
```

**用途**：扩展标准属性，增加类型标识便于在show/store函数中区分

### 3.4 预定义的类和设备
```c
// hw_power类下的设备
static struct power_sysfs_device_data g_power_sysfs_hw_power[] = {
    { "charger", NULL },      // /sys/class/hw_power/charger
    { "vsys_switch", NULL },  // /sys/class/hw_power/vsys_switch
    { "coul", NULL },         // /sys/class/hw_power/coul
    { "battery", NULL },      // /sys/class/hw_power/battery
};

// 全局类定义
static struct power_sysfs_class_data g_power_sysfs_class_data[] = {
    { "hw_power", NULL, g_power_sysfs_hw_power, 4 },
    { "hw_typec", NULL, NULL, 0 },   // Type-C相关
    { "hw_usb", NULL, NULL, 0 },     // USB相关
    { "hishow", NULL, NULL, 0 },     // 显示相关
    { "hw_accessory", NULL, NULL, 0 }, // 配件相关
};
```

---

## 4. 核心功能实现

### 4.1 模块初始化
```c
static int __init power_sysfs_init(void)
{
    int i, j;
    struct power_sysfs_class_data *cls_data = g_power_sysfs_class_data;
    int cls_size = ARRAY_SIZE(g_power_sysfs_class_data);
    
    // 遍历所有预定义的类
    for (i = 0; i < cls_size; i++) {
        // 1. 创建class（如 /sys/class/hw_power）
        cls_data[i].entity = power_sysfs_create_class(cls_data[i].name);
        if (!cls_data[i].entity)
            continue;

        if (!cls_data[i].dev_data)
            continue;

        // 2. 在class下创建devices（如 charger, battery等）
        l_class = cls_data[i].entity;
        dev_data = cls_data[i].dev_data;
        dev_size = cls_data[i].dev_size;
        for (j = 0; j < dev_size; j++)
            dev_data[j].entity = power_sysfs_create_device(l_class,
                dev_data[j].name);
    }
    
    return 0;
}
```

**执行时机**：`subsys_initcall` - 在子系统初始化阶段执行（早于设备驱动）

**执行结果**：创建5个class和4个hw_power下的device

### 4.2 创建属性组（最常用接口）
```c
struct device *power_sysfs_create_group(
    const char *cls_name,              // 类名："hw_power"
    const char *dev_name,              // 设备名："power_log"
    const struct attribute_group *group) // 属性组
{
    struct class *l_class = NULL;
    struct device *l_device = NULL;

    // 1. 获取已存在的class
    l_class = power_sysfs_get_class(cls_name);
    if (!l_class) {
        hwlog_err("class %s get fail\n", cls_name);
        return NULL;
    }

    // 2. 创建新device（如果是动态设备）
    l_device = power_sysfs_create_device(l_class, dev_name);
    if (!l_device) {
        hwlog_err("device %s get fail\n", dev_name);
        return NULL;
    }

    // 3. 在device下创建属性组
    if (sysfs_create_group(&l_device->kobj, group)) {
        power_sysfs_destroy_device(l_device);
        return NULL;
    }

    hwlog_info("group %s/%s create succ\n", cls_name, dev_name);
    return l_device;
}
```

**使用场景**：驱动模块创建自己的sysfs节点
```c
// 在power_log模块中
l_dev->dev = power_sysfs_create_group("hw_power", "power_log",
    &power_log_sysfs_attr_group);
// 结果：创建 /sys/class/hw_power/power_log/
```

### 4.3 创建符号链接组
```c
struct device *power_sysfs_create_link_group(
    const char *cls_name,              // 目标类："hw_power"
    const char *dev_name,              // 目标设备："charger"
    const char *link_name,             // 链接名："bq25892"
    struct device *target_dev,         // 真实设备
    const struct attribute_group *group) // 属性组
{
    struct device *l_device = NULL;

    // 1. 获取目标设备（预先存在）
    l_device = power_sysfs_get_device(cls_name, dev_name);
    if (!l_device) {
        hwlog_err("device %s get fail\n", dev_name);
        return NULL;
    }

    // 2. 在真实设备上创建属性组
    if (sysfs_create_group(&target_dev->kobj, group))
        return NULL;

    // 3. 在目标设备下创建指向真实设备的符号链接
    if (sysfs_create_link(&l_device->kobj, &target_dev->kobj, link_name))
        return NULL;

    hwlog_info("link group %s/%s/%s create succ\n",
        cls_name, dev_name, link_name);
    return l_device;
}
```

**使用场景**：I2C设备创建链接到统一路径
```bash
# 真实设备在 I2C 总线上
/sys/devices/platform/.../i2c-3/3-006b/bq25892/iin_thermal

# 创建符号链接便于访问
/sys/class/hw_power/charger/bq25892 -> /sys/devices/.../3-006b/bq25892
```

### 4.4 属性辅助函数

#### 4.4.1 初始化属性数组
```c
void power_sysfs_init_attrs(struct attribute **attrs,
    struct power_sysfs_attr_info *attr_info, int size)
{
    int i;
    
    // 将power_sysfs_attr_info数组转换为标准attribute数组
    for (i = 0; i < size; i++)
        attrs[i] = &attr_info[i].attr.attr;
    
    attrs[size] = NULL;  // 数组必须以NULL结尾
}
```

**使用场景**：
```c
// 定义属性信息表
static struct power_sysfs_attr_info power_log_sysfs_field_tbl[] = {
    power_sysfs_attr_rw(power_log, 0660, POWER_LOG_SYSFS_DEV_ID, dev_id),
    power_sysfs_attr_ro(power_log, 0440, POWER_LOG_SYSFS_HEAD, head),
};

// 准备属性数组
static struct attribute *power_log_sysfs_attrs[3];  // 2+1(NULL)

// 初始化
power_sysfs_init_attrs(power_log_sysfs_attrs,
    power_log_sysfs_field_tbl, 2);
```

#### 4.4.2 查找属性
```c
struct power_sysfs_attr_info *power_sysfs_lookup_attr(const char *name,
    struct power_sysfs_attr_info *attr_info, int size)
{
    int i;
    
    // 根据属性名查找对应的power_sysfs_attr_info
    for (i = 0; i < size; i++) {
        if (!strcmp(name, attr_info[i].attr.attr.name))
            return &attr_info[i];
    }
    
    return NULL;
}
```

**使用场景**：在show/store函数中区分属性
```c
static ssize_t power_log_sysfs_show(struct device *dev,
    struct device_attribute *attr, char *buf)
{
    struct power_sysfs_attr_info *info = NULL;
    
    // 查找是哪个属性被读取
    info = power_sysfs_lookup_attr(attr->attr.name,
        power_log_sysfs_field_tbl, POWER_LOG_SYSFS_ATTRS_SIZE);
    if (!info)
        return -EINVAL;

    // 根据类型ID执行不同操作
    switch (info->name) {
    case POWER_LOG_SYSFS_DEV_ID:
        // 处理dev_id读取
        break;
    case POWER_LOG_SYSFS_HEAD:
        // 处理head读取
        break;
    }
}
```

---

## 5. 属性定义宏

### 5.1 只读属性
```c
#define power_sysfs_attr_ro(_func, _mode, _type, _name) \
{ \
    .attr = __ATTR(_name, _mode, _func##_sysfs_show, NULL), \
    .name = _type, \
}
```

**使用示例**：
```c
// 定义
power_sysfs_attr_ro(power_log, 0440, POWER_LOG_SYSFS_HEAD, head)

// 展开为
{
    .attr = __ATTR(head, 0440, power_log_sysfs_show, NULL),
    .name = POWER_LOG_SYSFS_HEAD,
}

// 要求实现函数
static ssize_t power_log_sysfs_show(struct device *dev,
    struct device_attribute *attr, char *buf);
```

### 5.2 只写属性
```c
#define power_sysfs_attr_wo(_func, _mode, _type, _name) \
{ \
    .attr = __ATTR(_name, _mode, NULL, _func##_sysfs_store), \
    .name = _type, \
}
```

### 5.3 读写属性
```c
#define power_sysfs_attr_rw(_func, _mode, _type, _name) \
{ \
    .attr = __ATTR(_name, _mode, _func##_sysfs_show, _func##_sysfs_store), \
    .name = _type, \
}
```

**使用示例**：
```c
power_sysfs_attr_rw(charger, 0660, CHARGER_SYSFS_IIN_THERMAL, iin_thermal)

// 展开为
{
    .attr = __ATTR(iin_thermal, 0660, 
                   charger_sysfs_show, charger_sysfs_store),
    .name = CHARGER_SYSFS_IIN_THERMAL,
}

// 要求实现两个函数
static ssize_t charger_sysfs_show(...);
static ssize_t charger_sysfs_store(...);
```

---

## 6. 典型使用场景

### 6.1 场景1：创建简单的sysfs节点
```c
// 步骤1: 定义属性类型枚举
enum power_log_sysfs_type {
    POWER_LOG_SYSFS_DEV_ID = 0,
    POWER_LOG_SYSFS_HEAD,
    POWER_LOG_SYSFS_CONTENT,
};

// 步骤2: 定义属性信息表
static struct power_sysfs_attr_info power_log_sysfs_field_tbl[] = {
    power_sysfs_attr_rw(power_log, 0660, POWER_LOG_SYSFS_DEV_ID, dev_id),
    power_sysfs_attr_ro(power_log, 0440, POWER_LOG_SYSFS_HEAD, head),
    power_sysfs_attr_ro(power_log, 0440, POWER_LOG_SYSFS_CONTENT, content),
};

// 步骤3: 准备属性数组
#define POWER_LOG_SYSFS_ATTRS_SIZE ARRAY_SIZE(power_log_sysfs_field_tbl)
static struct attribute *power_log_sysfs_attrs[POWER_LOG_SYSFS_ATTRS_SIZE + 1];

// 步骤4: 定义属性组
static const struct attribute_group power_log_sysfs_attr_group = {
    .attrs = power_log_sysfs_attrs,
};

// 步骤5: 实现show/store函数
static ssize_t power_log_sysfs_show(struct device *dev,
    struct device_attribute *attr, char *buf)
{
    struct power_sysfs_attr_info *info = NULL;
    
    info = power_sysfs_lookup_attr(attr->attr.name,
        power_log_sysfs_field_tbl, POWER_LOG_SYSFS_ATTRS_SIZE);
    if (!info)
        return -EINVAL;

    switch (info->name) {
    case POWER_LOG_SYSFS_DEV_ID:
        return scnprintf(buf, PAGE_SIZE, "%d\n", current_dev_id);
    case POWER_LOG_SYSFS_HEAD:
        return scnprintf(buf, PAGE_SIZE, "VBUS VBAT IBAT\n");
    case POWER_LOG_SYSFS_CONTENT:
        return scnprintf(buf, PAGE_SIZE, "5000 4200 1500\n");
    default:
        return 0;
    }
}

// 步骤6: 初始化并创建
static int power_log_init(void)
{
    struct device *dev;
    
    // 初始化属性数组
    power_sysfs_init_attrs(power_log_sysfs_attrs,
        power_log_sysfs_field_tbl, POWER_LOG_SYSFS_ATTRS_SIZE);
    
    // 创建设备和属性组
    dev = power_sysfs_create_group("hw_power", "power_log",
        &power_log_sysfs_attr_group);
    if (!dev)
        return -EINVAL;
    
    return 0;
}

// 结果：创建以下节点
// /sys/class/hw_power/power_log/dev_id    (0660)
// /sys/class/hw_power/power_log/head      (0440)
// /sys/class/hw_power/power_log/content   (0440)
```

### 6.2 场景2：I2C设备创建符号链接
```c
// 在充电IC驱动的probe函数中
static int bq25892_probe(struct i2c_client *client)
{
    struct bq25892_device_info *di;
    struct device *link_dev;
    
    // ... 设备初始化 ...

    // 在I2C设备上创建属性组，并在hw_power/charger下创建链接
    link_dev = power_sysfs_create_link_group("hw_power", "charger",
        "bq25892", &client->dev, &bq25892_sysfs_attr_group);
    if (!link_dev)
        return -EINVAL;
    
    return 0;
}

// 结果：
// 真实节点: /sys/devices/.../i2c-3/3-006b/iin_thermal
// 符号链接: /sys/class/hw_power/charger/bq25892 -> /sys/devices/.../i2c-3/3-006b
//          可以通过 /sys/class/hw_power/charger/bq25892/iin_thermal 访问
```

### 6.3 场景3：查询已存在的设备
```c
// 其他模块需要访问预定义的设备
struct device *battery_dev;

battery_dev = power_sysfs_get_device("hw_power", "battery");
if (battery_dev) {
    // 可以在此设备下添加新的属性
    sysfs_create_file(&battery_dev->kobj, &some_attr);
}
```

---

## 7. 调试方法

### 7.1 检查类和设备创建状态
```bash
# 查看所有class
ls /sys/class/ | grep hw_
# 期望输出：
# hw_power
# hw_typec
# hw_usb
# hw_accessory

# 查看hw_power下的设备
ls /sys/class/hw_power/
# 期望输出：
# charger
# vsys_switch
# coul
# battery
# power_log  (如果power_log模块已加载)
```

### 7.2 检查模块初始化日志
```bash
dmesg | grep "power_sysfs\|create succ"
# 期望输出：
# [    5.123] power_sysfs: group hw_power/power_log create succ
# [    5.234] power_sysfs: link group hw_power/charger/bq25892 create succ
```

### 7.3 调试属性访问问题
```bash
# 1. 检查节点权限
ls -l /sys/class/hw_power/power_log/
# total 0
# -rw-rw---- 1 root system 4096 Jan  6 10:00 dev_id
# -r--r----- 1 root system 4096 Jan  6 10:00 head

# 2. 测试读取
cat /sys/class/hw_power/power_log/head
# 如果无输出，检查：
# - show函数是否正确实现
# - power_sysfs_lookup_attr是否找到对应属性
# - switch-case是否匹配

# 3. 测试写入
echo "test" > /sys/class/hw_power/power_log/dev_id
# 如果失败，检查dmesg：
dmesg | tail
# 可能输出：
# unable to parse input:test  --> store函数解析失败
```

### 7.4 检查符号链接
```bash
# 查看链接目标
ls -l /sys/class/hw_power/charger/
# lrwxrwxrwx 1 root root 0 Jan  6 10:00 bq25892 -> ../../devices/.../3-006b

# 验证链接有效性
cat /sys/class/hw_power/charger/bq25892/iin_thermal
# 应该返回数值，如：2000
```

### 7.5 常见错误排查

| 错误现象 | 可能原因 | 排查方法 |
|---------|---------|---------|
| `/sys/class/hw_power` 不存在 | power_sysfs模块未加载 | 检查 `lsmod \| grep power_sysfs` |
| `create_group` 返回NULL | class名称拼写错误 | 对比 `g_power_sysfs_class_data` 定义 |
| 属性节点不可见 | `init_attrs` 未调用 | 检查初始化顺序 |
| show函数未被调用 | 宏定义使用错误 | 检查函数名前缀是否匹配 |
| lookup_attr返回NULL | 属性名与定义不一致 | 对比宏中的 `_name` 参数 |

---

## 8. 与其他模块的交互

### 8.1 依赖关系
```
power_sysfs 模块依赖：
├── Linux Kernel sysfs     --> 标准内核sysfs机制
├── power_printk.h         --> 统一日志打印
└── 无其他电源模块依赖     --> 作为基础设施最先初始化
```

### 8.2 被依赖关系（所有电源模块）
**几乎所有电源模块**都依赖power_sysfs：
- **power_log**：创建 `/sys/class/hw_power/power_log/`
- **charger驱动**：在 `/sys/class/hw_power/charger/` 下创建链接
- **battery驱动**：使用预定义的 `battery` 设备
- **coul驱动**：使用预定义的 `coul` 设备
- **直充驱动**：创建动态设备节点

### 8.3 初始化顺序保证
```c
subsys_initcall(power_sysfs_init);  // 子系统级初始化（早）
    ↓
device_initcall(power_log_init);    // 设备级初始化（晚）
    ↓
module_init(charger_driver_init);   // 模块级初始化（更晚）
```

**设计保证**：power_sysfs在subsys阶段初始化，确保所有设备驱动加载时class和device已存在

---

## 9. 关键设计细节

### 9.1 为何预创建class和device
**设计原因**：
1. **统一管理**：避免多个驱动重复创建同名class
2. **避免冲突**：确保同一class只有一个实例
3. **简化驱动**：驱动只需查找而非创建，减少错误处理
4. **启动优化**：集中创建比分散创建效率更高

### 9.2 为何使用符号链接
**实际问题**：
- I2C设备的真实路径很长且不固定
  ```
  /sys/devices/platform/soc/fe0d0000.i2c/i2c-3/3-006b/iin_thermal
  ```
- 不同板型I2C总线号可能不同（i2c-3 vs i2c-5）

**解决方案**：创建固定路径的符号链接
```
/sys/class/hw_power/charger/bq25892/iin_thermal  ← 应用层只需访问这个
```

### 9.3 为何属性结构包含类型ID
**标准内核做法**：每个属性对应一个show/store函数
```c
// 传统方式：需要定义N个函数
static ssize_t dev_id_show(...) { }
static ssize_t head_show(...) { }
static ssize_t content_show(...) { }
```

**power_sysfs优化**：一个show函数处理所有属性
```c
// 优化方式：只需一个函数+switch
static ssize_t power_log_sysfs_show(...)
{
    switch (info->name) {  // info->name就是类型ID
    case POWER_LOG_SYSFS_DEV_ID: ...
    case POWER_LOG_SYSFS_HEAD: ...
    case POWER_LOG_SYSFS_CONTENT: ...
    }
}
```

**优点**：
- 减少函数数量
- 便于共享逻辑（如权限检查、设备指针获取）
- 更容易维护

### 9.4 为何属性数组需要NULL结尾
**内核要求**：`attribute_group.attrs` 必须是NULL结尾的数组
```c
// 内核在遍历属性时
for (i = 0; group->attrs[i] != NULL; i++) {
    create_attr(group->attrs[i]);
}
```

**power_sysfs_init_attrs的作用**：自动添加NULL终止符
```c
attrs[size] = NULL;  // 确保数组正确终止
```

---

## 10. 最佳实践建议

### 10.1 模块开发者
1. **使用预定义设备**：优先使用 `charger/battery/coul/vsys_switch`
   ```c
   // 推荐：使用已存在的设备
   dev = power_sysfs_get_device("hw_power", "battery");
   sysfs_create_file(&dev->kobj, &my_attr);
   
   // 避免：创建新设备（除非真的需要）
   dev = power_sysfs_create_group("hw_power", "my_new_device", ...);
   ```

2. **遵循命名规范**：
   - 类型枚举：`MODULE_SYSFS_TYPE_XXX`
   - 函数前缀：`module_sysfs_show/store`
   - 属性名：小写+下划线，如 `iin_thermal`

3. **正确使用宏**：
   ```c
   // 正确：函数前缀与宏参数一致
   power_sysfs_attr_ro(charger, 0444, TYPE_A, node_a)
   static ssize_t charger_sysfs_show(...) { }
   
   // 错误：函数名不匹配
   power_sysfs_attr_ro(charger, 0444, TYPE_A, node_a)
   static ssize_t my_show(...) { }  // ✗ 宏会生成charger_sysfs_show
   ```

### 10.2 调试技巧
1. **快速定位节点**：
   ```bash
   find /sys/class/hw_power -name "*thermal*"
   # 查找所有thermal相关节点
   ```

2. **批量测试读写**：
   ```bash
   # 测试所有可读节点
   for f in /sys/class/hw_power/battery/*; do
       echo "=== $f ==="
       cat "$f" 2>&1 | head -5
   done
   ```

3. **监控动态创建**：
   ```bash
   # 实时监控sysfs变化
   inotifywait -m -r /sys/class/hw_power/
   ```

### 10.3 性能优化
1. **避免频繁查找**：
   ```c
   // 不推荐：每次都查找
   void func1() {
       dev = power_sysfs_get_device("hw_power", "battery");
       // 使用dev...
   }
   void func2() {
       dev = power_sysfs_get_device("hw_power", "battery");
       // 使用dev...
   }
   
   // 推荐：查找一次，缓存起来
   static struct device *g_battery_dev;
   
   void init() {
       g_battery_dev = power_sysfs_get_device("hw_power", "battery");
   }
   
   void func1() { /* 使用g_battery_dev */ }
   void func2() { /* 使用g_battery_dev */ }
   ```

2. **合并属性组**：
   ```c
   // 不推荐：多次调用sysfs_create_file
   sysfs_create_file(&dev->kobj, &attr1);
   sysfs_create_file(&dev->kobj, &attr2);
   sysfs_create_file(&dev->kobj, &attr3);
   
   // 推荐：使用attribute_group一次创建
   sysfs_create_group(&dev->kobj, &attr_group);
   ```

---

## 11. 实际应用示例

### 11.1 查看系统所有电源节点
```bash
#!/bin/bash
# power_sysfs_dump.sh - 导出所有电源sysfs节点信息

echo "=== Power Sysfs Topology ==="
for cls in hw_power hw_typec hw_usb hw_accessory; do
    if [ -d "/sys/class/$cls" ]; then
        echo "Class: $cls"
        for dev in /sys/class/$cls/*; do
            [ -d "$dev" ] || continue
            dev_name=$(basename "$dev")
            echo "  Device: $dev_name"
            for attr in "$dev"/*; do
                [ -f "$attr" ] || continue
                attr_name=$(basename "$attr")
                perm=$(stat -c "%a" "$attr")
                echo "    - $attr_name ($perm)"
            done
        done
    fi
done

# 输出示例：
# Class: hw_power
#   Device: charger
#     - iin_thermal (660)
#     - enable_charger (660)
#   Device: battery
#     - capacity (444)
#     - temp (444)
#   Device: power_log
#     - dev_id (660)
#     - head (440)
#     - content (440)
```

### 11.2 电源参数监控脚本
```bash
#!/bin/bash
# monitor_charging.sh - 实时监控充电状态

while true; do
    clear
    echo "=== Charging Monitor ($(date)) ==="
    echo ""
    
    echo "Battery:"
    echo "  Capacity: $(cat /sys/class/hw_power/battery/capacity)%"
    echo "  Voltage:  $(cat /sys/class/hw_power/battery/voltage_now) uV"
    echo "  Current:  $(cat /sys/class/hw_power/battery/current_now) uA"
    echo "  Temp:     $(cat /sys/class/hw_power/battery/temp)°C"
    echo ""
    
    echo "Charger:"
    echo "  Type:     $(cat /sys/class/hw_power/charger/charger_type)"
    echo "  Iin:      $(cat /sys/class/hw_power/charger/iin_thermal) mA"
    echo "  Ichg:     $(cat /sys/class/hw_power/charger/ichg_thermal) mA"
    echo ""
    
    sleep 2
done
```

---

## 12. 总结

### 12.1 核心特性
| 特性 | 说明 |
|-----|------|
| **统一管理** | 集中管理5个class和多个预定义device |
| **简化开发** | 提供宏和辅助函数，减少70%样板代码 |
| **符号链接** | 解决I2C设备路径不固定的问题 |
| **类型安全** | 通过枚举+switch替代字符串比较 |
| **早期初始化** | subsys_initcall确保优先于所有驱动 |

### 12.2 价值体现
1. **开发效率**：新增sysfs节点只需3步（定义宏→实现show/store→调用create_group）
2. **代码复用**：所有模块共享同一套class/device，避免重复创建
3. **用户体验**：统一的路径结构（`/sys/class/hw_power/*`）便于脚本开发
4. **维护性**：集中式管理便于全局修改和调试

### 12.3 设计模式总结
```
power_sysfs采用的设计模式：
├── 工厂模式        --> create_group/create_link_group
├── 单例模式        --> 每个class只有一个实例
├── 注册表模式      --> 预定义class和device数组
├── 辅助者模式      --> init_attrs/lookup_attr辅助函数
└── 模板方法模式    --> 宏定义自动生成重复代码
```

### 12.4 与其他公共模块的定位
- **power_sysfs**：sysfs基础设施（用户空间接口）← **当前模块**
- **power_event**：事件通知机制（内核空间通信）
- **power_vote**：参数仲裁机制（优先级决策）
- **power_dsm**：异常上报机制（云端监控）
- **power_log**：日志收集机制（调试支持）

五者共同构建了**完整的电源管理基础设施**，power_sysfs作为用户空间接口层是最基础的模块。

---

**文档版本**：v1.0  
**分析日期**：2026-01-06  
**适用平台**：Huawei MATE X5 (Kernel 5.10)  
**模块层级**：基础设施层（Infrastructure Layer）