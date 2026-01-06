---
outline: deep
---

# 华为电池核心之battery_temp模块


## 一、模块概述

battery_temp.c 是华为电源管理框架中的**电池温度管理驱动**，核心功能：
- **多温度源管理**（支持双电池温度）
- **温度读取抽象层**（统一接口）
- **实时温度与统计温度分离**
- **温度测试支持**（手动输入模拟温度）

---

## 二、核心数据结构

### 1. **设备信息结构体**
```c
struct bat_temp_info {
    struct device *dev;                    // 设备指针
    char name[BAT_TEMP_NAME_MAX + 1];      // 温度驱动名称 (最大 64 字符)
    struct bat_temp_ops *ops;              // 温度操作函数集
    unsigned int test_flag;                // 测试模式标志 (0=正常, 1=测试)
    int input_tbat;                        // 手动输入的测试温度 (°C)
};
```

### 2. **温度操作接口**

```c
struct bat_temp_ops {
    int (*get_rt_temp)(enum bat_temp_id id, int *temp);  // 获取实时温度
    int (*get_temp)(enum bat_temp_id id, int *temp);     // 获取统计温度
};
```

#### 温度类型区别：
| 类型 | 函数 | 说明 | 应用场景 |
|------|------|------|---------|
| **实时温度** | `get_rt_temp()` | 当前瞬时采样值 | 快速响应、过温保护 |
| **统计温度** | `get_temp()` | 滤波/平均后的值 | 充电控制、UI 显示 |

### 3. **温度 ID 枚举**
```c
enum bat_temp_id {
    BAT_TEMP_0 = 0,        // 第一块电池温度
    BAT_TEMP_1,            // 第二块电池温度
    BAT_TEMP_MIXED,        // 混合温度（双电池融合）
    BTB_TEMP_0 = 0,        // 板对板连接器温度 0
    BTB_TEMP_1,            // 板对板连接器温度 1
    BTB_TEMP_MIXED,        // 混合 BTB 温度
};
```

---

## 三、关键功能模块

### 1. **温度获取接口**

#### (1) 统计温度获取：

```c
int bat_temp_get_temperature(enum bat_temp_id id, int *temp)
{
    struct bat_temp_info *di = g_bat_temp_info;
    
    // 1. 参数校验
    if (!temp) {
        hwlog_err("temp is null\n");
        return -EINVAL;
    }
    
    // 2. 检查电池是否存在
    if (!power_platform_is_battery_exit())
        hwlog_err("battery not exist\n");
    
    // 3. 未注册温度驱动，使用平台默认接口
    if (!di) {
        *temp = power_platform_get_battery_temperature();
        hwlog_info("default temp api: temp %d\n", *temp);
        return 0;
    }
    
    // 4. 操作函数未注册
    if (!di->ops || !di->ops->get_temp) {
        *temp = POWER_TEMP_INVALID_TEMP / POWER_MC_PER_C;
        hwlog_info("bat_temp_ops not exist\n");
        return -EINVAL;
    }
    
    // 5. 测试模式：返回手动输入的温度
    if (di->test_flag) {
        *temp = di->input_tbat;
        return 0;
    }
    
    // 6. 健康监测运行测试模式
#ifdef CONFIG_HLTHERM_RUNTEST
    *temp = POWER_TEMP_DEFAULT_TEMP;
    return 0;
#else
    // 7. 调用注册的温度读取函数
    return di->ops->get_temp(id, temp);
#endif
}
```

#### (2) 实时温度获取：

```c
int bat_temp_get_rt_temperature(enum bat_temp_id id, int *temp)
{
    // 逻辑与 bat_temp_get_temperature() 完全相同
    // 唯一区别：调用 ops->get_rt_temp() 而非 ops->get_temp()
    
    // 测试模式同样生效
    if (di->test_flag) {
        *temp = di->input_tbat;
        return 0;
    }
    
    // 调用实时温度读取函数
    return di->ops->get_rt_temp(id, temp);
}
```

#### 调用示例：
```c
int temp_bat0 = 0;
int temp_mixed = 0;

// 获取第一块电池的统计温度
bat_temp_get_temperature(BAT_TEMP_0, &temp_bat0);

// 获取混合温度（双电池融合算法）
bat_temp_get_temperature(BAT_TEMP_MIXED, &temp_mixed);

// 获取实时温度（快速响应）
bat_temp_get_rt_temperature(BAT_TEMP_0, &temp_bat0);
```

---

### 2. **温度驱动注册**
```c
int bat_temp_ops_register(const char *name, struct bat_temp_ops *ops)
{
    // 1. 参数校验
    if (!name || !ops || !ops->get_temp || !ops->get_rt_temp) {
        hwlog_err("input arg err\n");
        return -EINVAL;
    }
    
    // 2. 检查全局设备指针
    if (!g_bat_temp_info) {
        hwlog_err("temp info ptr is null\n");
        return -ENODEV;
    }
    
    // 3. 名称长度校验
    if (strlen(name) >= BAT_TEMP_NAME_MAX) {
        hwlog_err("%s is err\n", name);
        return -EINVAL;
    }
    
    // 4. 注册驱动
    strlcpy(g_bat_temp_info->name, name, BAT_TEMP_NAME_MAX);
    g_bat_temp_info->ops = ops;
    
    return 0;
}
```

#### 注册示例：
```c
// 示例：双电池温度驱动注册
static int dual_bat_get_temp(enum bat_temp_id id, int *temp)
{
    switch (id) {
    case BAT_TEMP_0:
        *temp = read_ntc_temp(0);  // 读取 NTC0
        break;
    case BAT_TEMP_1:
        *temp = read_ntc_temp(1);  // 读取 NTC1
        break;
    case BAT_TEMP_MIXED:
        // 混合算法：取最大值或加权平均
        *temp = max(read_ntc_temp(0), read_ntc_temp(1));
        break;
    }
    return 0;
}

static int dual_bat_get_rt_temp(enum bat_temp_id id, int *temp)
{
    // 实时温度：无滤波
    return dual_bat_get_temp(id, temp);
}

static struct bat_temp_ops dual_bat_ops = {
    .get_temp = dual_bat_get_temp,
    .get_rt_temp = dual_bat_get_rt_temp,
};

// 在初始化函数中注册
static int __init dual_bat_temp_init(void)
{
    return bat_temp_ops_register("dual_battery_temp", &dual_bat_ops);
}
```

---

### 3. **Sysfs 接口**
#### 节点列表：

| 节点名 | 权限 | 类型 | 功能 | 温度类型 |
|--------|------|------|------|---------|
| `bat_0` | R (0440) | RO | 读取电池 0 统计温度 | 统计 |
| `bat_1` | R (0440) | RO | 读取电池 1 统计温度 | 统计 |
| `bat_mixed` | R (0440) | RO | 读取混合统计温度 | 统计 |
| `bat_0_now` | R (0440) | RO | 读取电池 0 实时温度 | 实时 |
| `bat_1_now` | R (0440) | RO | 读取电池 1 实时温度 | 实时 |
| `bat_mixed_now` | R (0440) | RO | 读取混合实时温度 | 实时 |
| `bat_temp_name` | R (0440) | RO | 读取温度驱动名称 | - |
| `test_flag` | RW (0644) | RW | 测试模式开关 | - |
| `input_tbat` | RW (0644) | RW | 手动输入测试温度 | - |

#### Sysfs Show 函数

```c
static ssize_t bat_temp_sysfs_show(struct device *dev,
    struct device_attribute *attr, char *buf)
{
    switch (info->name) {
    case SYSFS_BAT_TEMP_0:
    case SYSFS_BAT_TEMP_1:
    case SYSFS_BAT_TEMP_MIXED:
        // 统计温度：偏移量计算 (SYSFS_BAT_TEMP_0 = 0)
        bat_temp_get_temperature(info->name - SYSFS_BAT_TEMP_0, &bat_temp);
        len = snprintf(buf, PAGE_SIZE, "%d\n", bat_temp);
        break;
        
    case SYSFS_BAT_TEMP_0_NOW:
    case SYSFS_BAT_TEMP_1_NOW:
    case SYSFS_BAT_TEMP_MIXED_NOW:
        // 实时温度：偏移量计算
        bat_temp_get_rt_temperature(info->name - SYSFS_BAT_TEMP_0_NOW,
            &bat_temp);
        len = snprintf(buf, PAGE_SIZE, "%d\n", bat_temp);
        break;
        
    case SYSFS_BAT_TEMP_NAME:
        // 驱动名称
        len = snprintf(buf, PAGE_SIZE, "%s\n", di->name);
        break;
        
    case SYSFS_BAT_TEMP_TEST_FLAG:
        // 测试标志
        len = snprintf(buf, PAGE_SIZE, "%u\n", di->test_flag);
        break;
        
    case SYSFS_INPUT_BAT_TEMP:
        // 手动输入的温度
        len = snprintf(buf, PAGE_SIZE, "%d\n", di->input_tbat);
        break;
    }
    
    return len;
}
```

#### Sysfs Store 函数

```c
static ssize_t bat_temp_sysfs_store(struct device *dev,
    struct device_attribute *attr, const char *buf, size_t count)
{
    switch (info->name) {
    case SYSFS_BAT_TEMP_TEST_FLAG:
        // 测试标志：只能为 0 或 1
        if ((kstrtol(buf, POWER_BASE_DEC, &val) < 0) || 
            (val < 0) || (val > 1))
            return -EINVAL;
        di->test_flag = (unsigned int)val;
        hwlog_info("set test start flag = %u\n", di->test_flag);
        break;
        
    case SYSFS_INPUT_BAT_TEMP:
        // 手动温度：范围 -40°C ~ 80°C
        if ((kstrtol(buf, POWER_BASE_DEC, &val) < 0) || 
            (val < -40) || (val > 80))
            return -EINVAL;
        di->input_tbat = (int)val;
        hwlog_info("set input batt temp = %d\n", di->input_tbat);
        break;
    }
    
    return count;
}
```

#### 节点路径：
```bash
/sys/class/hw_power/charger/hw_bat_temp/
├── bat_0           (R, 0440) - 电池 0 统计温度 (°C)
├── bat_1           (R, 0440) - 电池 1 统计温度 (°C)
├── bat_mixed       (R, 0440) - 混合统计温度 (°C)
├── bat_0_now       (R, 0440) - 电池 0 实时温度 (°C)
├── bat_1_now       (R, 0440) - 电池 1 实时温度 (°C)
├── bat_mixed_now   (R, 0440) - 混合实时温度 (°C)
├── bat_temp_name   (R, 0440) - 温度驱动名称
├── test_flag       (RW, 0644) - 测试模式标志 (0/1)
└── input_tbat      (RW, 0644) - 手动输入温度 (-40~80)
```

---

### 4. **测试模式**

#### 测试流程：

```bash
# 1. 启用测试模式
echo 1 > /sys/class/hw_power/charger/hw_bat_temp/test_flag

# 2. 设置模拟温度 (例如 45°C)
echo 45 > /sys/class/hw_power/charger/hw_bat_temp/input_tbat

# 3. 读取温度（会返回设置的 45°C）
cat /sys/class/hw_power/charger/hw_bat_temp/bat_0
# 输出: 45

cat /sys/class/hw_power/charger/hw_bat_temp/bat_mixed_now
# 输出: 45

# 4. 关闭测试模式（恢复真实温度）
echo 0 > /sys/class/hw_power/charger/hw_bat_temp/test_flag
```

#### 代码逻辑：
```c
// 在 bat_temp_get_temperature() 中
if (di->test_flag) {
    *temp = di->input_tbat;  // 返回手动设置的温度
    return 0;
}

// 正常模式
return di->ops->get_temp(id, temp);  // 返回真实温度
```

#### 应用场景：
- **充电算法调试** - 模拟不同温度下的充电行为
- **温控策略验证** - 测试高温/低温保护逻辑
- **老化测试** - 模拟极端温度环境
- **自动化测试** - 脚本化测试充电流程

---

## 四、初始化流程

```
bat_temp_probe()
├── 1. 参数校验
│   └── 检查 pdev 和 device_node
├── 2. 分配设备结构体
│   └── devm_kzalloc(sizeof(struct bat_temp_info))
├── 3. 设置全局指针
│   └── g_bat_temp_info = di
├── 4. 初始化设备数据
│   ├── di->dev = &pdev->dev
│   ├── di->test_flag = 0 (正常模式)
│   └── platform_set_drvdata(pdev, di)
├── 5. 创建 Sysfs 节点
│   └── bat_temp_sysfs_create_group()
│       └── /sys/class/hw_power/charger/hw_bat_temp/
└── 6. 等待温度驱动注册
    └── 其他模块调用 bat_temp_ops_register()
```

---

## 五、温度驱动架构

### 1. **分层设计**

```
应用层 (User Space)
    ↓ sysfs 接口
battery_temp.c (抽象层)
    ↓ bat_temp_ops
具体温度驱动 (实现层)
    ├── dual_battery_temp.c (双电池温度)
    ├── single_battery_temp.c (单电池温度)
    └── coul_temp.c (库仑计温度)
    ↓ 硬件接口
硬件层 (ADC/NTC/I2C)
```

### 2. **插件式设计**

```c
// 框架层提供统一接口
int bat_temp_get_temperature(enum bat_temp_id id, int *temp);

// 具体驱动实现细节
// 驱动 A: 双 NTC 方案
static int dual_ntc_get_temp(enum bat_temp_id id, int *temp) {
    *temp = adc_read_ntc(id);
}

// 驱动 B: 库仑计方案
static int coul_get_temp(enum bat_temp_id id, int *temp) {
    *temp = i2c_read_coul_temp(id);
}

// 驱动 C: 热敏电阻 + ADC 方案
static int thermistor_get_temp(enum bat_temp_id id, int *temp) {
    int adc_val = adc_read(channel);
    *temp = adc_to_temp(adc_val);  // 查表转换
}
```

---

## 六、典型应用场景

### 场景 1：充电温度控制

```c
// 充电管理模块
void charging_temp_control(void)
{
    int temp_bat0 = 0;
    int temp_mixed = 0;
    
    // 获取电池温度
    bat_temp_get_temperature(BAT_TEMP_0, &temp_bat0);
    bat_temp_get_temperature(BAT_TEMP_MIXED, &temp_mixed);
    
    // 温度过低（< 15°C）
    if (temp_mixed < 15) {
        set_charge_current(500);  // 降低充电电流
        hwlog_info("low temp, slow charge\n");
    }
    // 温度过高（> 40°C）
    else if (temp_mixed > 40) {
        stop_charging();  // 停止充电
        hwlog_err("high temp, stop charge\n");
    }
    // 正常温度
    else {
        set_charge_current(3000);  // 快充
    }
}
```

### 场景 2：过温保护

```c
// 热保护模块
void thermal_protection_check(void)
{
    int temp_rt = 0;
    
    // 获取实时温度（快速响应）
    bat_temp_get_rt_temperature(BAT_TEMP_MIXED, &temp_rt);
    
    // 紧急过温（> 60°C）
    if (temp_rt > 60) {
        emergency_shutdown();  // 紧急关机
        hwlog_err("critical temp %d, shutdown!\n", temp_rt);
    }
}
```

### 场景 3：双电池温度监控

```c
// 双电池监控
void dual_battery_temp_monitor(void)
{
    int temp0 = 0, temp1 = 0;
    
    bat_temp_get_temperature(BAT_TEMP_0, &temp0);
    bat_temp_get_temperature(BAT_TEMP_1, &temp1);
    
    // 温差过大（> 5°C）
    if (abs(temp0 - temp1) > 5) {
        hwlog_warn("temp diff: bat0=%d, bat1=%d\n", temp0, temp1);
        trigger_balancing();  // 触发均衡
    }
}
```

### 场景 4：测试脚本

```bash
#!/system/bin/sh
# 充电温度测试脚本

# 启用测试模式
echo 1 > /sys/class/hw_power/charger/hw_bat_temp/test_flag

# 测试低温充电 (0°C)
echo 0 > /sys/class/hw_power/charger/hw_bat_temp/input_tbat
sleep 5
cat /sys/class/power_supply/battery/charge_current_now
# 预期：500mA (低温慢充)

# 测试常温充电 (25°C)
echo 25 > /sys/class/hw_power/charger/hw_bat_temp/input_tbat
sleep 5
cat /sys/class/power_supply/battery/charge_current_now
# 预期：3000mA (快充)

# 测试高温充电 (45°C)
echo 45 > /sys/class/hw_power/charger/hw_bat_temp/input_tbat
sleep 5
cat /sys/class/power_supply/battery/status
# 预期：Not charging (停止充电)

# 关闭测试模式
echo 0 > /sys/class/hw_power/charger/hw_bat_temp/test_flag
```

---

## 七、关键宏定义

```c
BAT_TEMP_NAME_MAX    64      // 驱动名称最大长度
BAT_TEMP_LOW         15000   // 低温阈值 15°C (milli-degree)
BAT_TEMP_HIGH        40000   // 高温阈值 40°C (milli-degree)
```

---

## 八、温度单位说明

### 代码中的温度单位：

```c
// 函数接口返回：°C (摄氏度)
int temp = 0;
bat_temp_get_temperature(BAT_TEMP_0, &temp);
// temp = 25 表示 25°C

// 宏定义单位：millidegree (千分之一度)
BAT_TEMP_LOW = 15000   // 15000 / 1000 = 15°C
BAT_TEMP_HIGH = 40000  // 40000 / 1000 = 40°C

// Sysfs 节点单位：°C (摄氏度)
cat /sys/class/hw_power/charger/hw_bat_temp/bat_0
# 输出: 25 (表示 25°C)
```

---

## 九、与其他模块的交互

```
battery_temp.c (温度抽象层)
    ↑ 温度查询
    │
├── battery_core.c (电池核心)
│   └── 获取温度用于健康度判断
├── charge_manager.c (充电管理)
│   └── 获取温度控制充电电流
├── battery_fault.c (故障检测)
│   └── 获取温度判断低温截止电压
├── thermal_zone.c (热管理)
│   └── 获取温度上报到系统热管理
└── battery_ui_capacity.c (UI 电量)
    └── 获取温度影响电量显示
```

---

## 十、健康监测模式

```c
#ifdef CONFIG_HLTHERM_RUNTEST
    *temp = POWER_TEMP_DEFAULT_TEMP;  // 返回默认温度
    return 0;
#endif
```

**CONFIG_HLTHERM_RUNTEST** - 健康监测运行测试模式
- 用于健康度监测算法的自动化测试
- 返回固定温度值，排除温度波动的干扰
- 确保测试结果的可重复性

---

## 十一、调试方法

### 1. **查看当前温度**
```bash
# 统计温度
cat /sys/class/hw_power/charger/hw_bat_temp/bat_0
cat /sys/class/hw_power/charger/hw_bat_temp/bat_1
cat /sys/class/hw_power/charger/hw_bat_temp/bat_mixed

# 实时温度
cat /sys/class/hw_power/charger/hw_bat_temp/bat_0_now
cat /sys/class/hw_power/charger/hw_bat_temp/bat_1_now
cat /sys/class/hw_power/charger/hw_bat_temp/bat_mixed_now
```

### 2. **查看驱动名称**
```bash
cat /sys/class/hw_power/charger/hw_bat_temp/bat_temp_name
# 输出: dual_battery_temp (示例)
```

### 3. **测试模式调试**
```bash
# 检查测试模式状态
cat /sys/class/hw_power/charger/hw_bat_temp/test_flag
# 0 = 正常模式, 1 = 测试模式

# 启用测试模式
echo 1 > /sys/class/hw_power/charger/hw_bat_temp/test_flag

# 设置测试温度
echo 30 > /sys/class/hw_power/charger/hw_bat_temp/input_tbat

# 验证测试温度生效
cat /sys/class/hw_power/charger/hw_bat_temp/bat_0
# 应输出: 30
```

### 4. **查看日志**
```bash
dmesg | grep bat_temp
# 查找温度相关日志
# "default temp api: temp XXX"
# "set test start flag = X"
# "set input batt temp = X"
```

---

## 十二、温度读取失败处理

```c
// 未注册温度驱动时的默认行为
if (!di) {
    *temp = power_platform_get_battery_temperature();
    hwlog_info("default temp api: temp %d\n", *temp);
    return 0;
}

// 操作函数未注册时返回无效温度
if (!di->ops || !di->ops->get_temp) {
    *temp = POWER_TEMP_INVALID_TEMP / POWER_MC_PER_C;
    hwlog_info("bat_temp_ops not exist\n");
    return -EINVAL;
}
```

**降级策略：**
1. 优先使用注册的温度驱动
2. 未注册时使用平台默认接口
3. 平台接口失败时返回无效温度标志

---

## 十三、总结

**battery_temp.c 核心特点：**

1. **抽象层设计** - 隔离硬件差异，统一温度接口
2. **双温度模式** - 实时温度（快速）+ 统计温度（稳定）
3. **多温度源支持** - 单电池/双电池/混合温度
4. **测试友好** - 手动输入温度，方便算法调试
5. **降级保护** - 驱动未注册时使用默认接口

**应用价值：**
- 充电安全保护（温度控制充电功率）
- 热管理（过温保护）
- 电池健康度评估（温度影响老化）
- UI 显示（温度警告提示）

这是电池管理系统中**温度监控的基础框架**，为上层提供了统一、可靠的温度数据接口！