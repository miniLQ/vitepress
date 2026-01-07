---
outline: deep
---

# power_sw 模块分析

## 1. 模块定位与核心价值

`power_sw` 是华为充电框架中的**通用电源开关抽象层**（Power Switch Abstraction Layer），提供统一的硬件开关控制接口，支持 GPIO 和其他实现方式。该模块将不同的硬件开关（如 OVP 开关、无线充电开关、充电路径开关等）抽象为统一的操作接口。

### 核心特性

- **统一接口**：提供标准的 ON/OFF 控制 API
- **多实现支持**：支持 GPIO、I2C、其他硬件实现
- **索引访问**：通过索引或标签访问开关
- **注册机制**：模块化注册，解耦硬件实现
- **即插即用**：设备树配置，无需代码修改

### 应用背景

充电系统中有大量的开关控制需求：
- **OVP 开关**：过压保护路径切换
- **无线充电开关**：无线 RX/TX 路径控制
- **充电路径开关**：主辅路径切换
- **电源域开关**：各子系统供电使能

传统方式每个模块独立实现 GPIO 控制，代码重复且难以维护。`power_sw` 提供统一抽象，简化开发。

---

## 2. 系统架构

### 2.1 分层架构图

```
┌─────────────────────────────────────────────────────────────────┐
│                      应用层 (Consumers)                          │
│                                                                  │
│  ┌────────────────┬────────────────┬────────────────────────┐  │
│  │ OVP Switch     │ Wireless Charge│ Channel Switch         │  │
│  │ (过压保护开关) │ (无线充电开关) │ (充电通道开关)         │  │
│  └────────────────┴────────────────┴────────────────────────┘  │
└─────────────────────────────────────────────────────────────────┘
                              ↓
                    调用统一的 power_sw API
                              ↓
┌─────────────────────────────────────────────────────────────────┐
│                   power_sw 抽象层 (核心模块)                     │
│                                                                  │
│  ┌──────────────────────────────────────────────────────────┐  │
│  │ 全局开关数组 g_pwr_sw[8]                                 │  │
│  │                                                          │  │
│  │  [0] label: "charger_ovp"     ready: true               │  │
│  │  [1] label: "wireless_rx_sw"  ready: true               │  │
│  │  [2] label: "wireless_sc_sw"  ready: true               │  │
│  │  [3] label: "vbus_aux_sw"     ready: true               │  │
│  │  [4] ~                         ready: false              │  │
│  │  ...                                                     │  │
│  └──────────────────────────────────────────────────────────┘  │
│                              ↓                                   │
│  ┌──────────────────────────────────────────────────────────┐  │
│  │ 统一接口                                                  │  │
│  │  • power_sw_set_output(idx, ON/OFF)                      │  │
│  │  • power_sw_get_output(idx)                              │  │
│  │  • power_sw_set_output_by_label(label, ON/OFF)           │  │
│  │  • power_sw_get_output_by_label(label)                   │  │
│  │  • power_sw_register(idx, sw)                            │  │
│  └──────────────────────────────────────────────────────────┘  │
└─────────────────────────────────────────────────────────────────┘
                              ↓
          每个开关实例包含 ops 函数指针 (set/get/free)
                              ↓
┌─────────────────────────────────────────────────────────────────┐
│                   实现层 (Implementations)                       │
│                                                                  │
│  ┌────────────────────────────────────────────────────────┐    │
│  │ GPIO 实现 (默认)                                       │    │
│  │  • power_sw_set_by_gpio()    - gpio_direction_output() │    │
│  │  • power_sw_get_by_gpio()    - gpio_get_value()        │    │
│  │  • power_sw_free_by_gpio()   - gpio_free()             │    │
│  └────────────────────────────────────────────────────────┘    │
│                                                                  │
│  ┌────────────────────────────────────────────────────────┐    │
│  │ 其他实现（可扩展）                                      │    │
│  │  • I2C expander                                         │    │
│  │  • PMIC GPIO                                            │    │
│  │  • FPGA 控制                                            │    │
│  └────────────────────────────────────────────────────────┘    │
└─────────────────────────────────────────────────────────────────┘
                              ↓
┌─────────────────────────────────────────────────────────────────┐
│                        硬件层 (Hardware)                         │
│                                                                  │
│  ┌──────────────┬──────────────┬──────────────┬──────────────┐ │
│  │ GPIO_123     │ GPIO_124     │ GPIO_125     │ GPIO_126     │ │
│  │ (OVP 开关)   │ (RX 开关)    │ (SC 开关)    │ (AUX 开关)   │ │
│  └──────────────┴──────────────┴──────────────┴──────────────┘ │
└─────────────────────────────────────────────────────────────────┘
```

### 2.2 数据流图

#### 设置开关流程

```
应用层调用
    ↓
power_sw_set_output(idx=0, status=POWER_SW_ON)
    ↓
检查索引有效性 (0 < idx < 8)
    ↓
检查开关是否就绪 (g_pwr_sw[idx].ready == true)
    ↓
调用开关的 set 函数指针
    ↓
g_pwr_sw[idx].set(&attr, POWER_SW_ON)
    ↓
power_sw_set_by_gpio(&attr, POWER_SW_ON)
    ↓
gpio_direction_output(gpio_num, attr.en)
    ↓
硬件 GPIO 输出高/低电平
    ↓
开关物理闭合/断开
```

#### 通过标签访问流程

```
应用层调用
    ↓
power_sw_set_output_by_label("charger_ovp", POWER_SW_ON, false)
    ↓
power_sw_get_idx_by_label("charger_ovp")
    ↓
遍历 g_pwr_sw[0..7]，查找匹配的 label
    ↓
找到索引 idx = 0
    ↓
检查当前状态（如果 force=false）
    ↓
调用 power_sw_set_output(idx=0, POWER_SW_ON)
    ↓
执行实际的开关操作
```

---

## 3. 核心数据结构

### 3.1 开关属性结构体

```c
struct power_sw_attr {
    void *dev;           // 设备指针（预留）
    int num;             // 硬件编号（GPIO 编号、I2C 地址等）
    int dflt;            // 默认状态（0 或 1）
    int en;              // 使能极性（高电平有效=1，低电平有效=0）
    const char *label;   // 开关标签名称（用于查找）
};
```

**字段说明**：
- `num`: GPIO 实现时表示 GPIO 编号
- `dflt`: 初始化时的默认状态
- `en`: 控制极性，决定高/低电平对应 ON/OFF
- `label`: 字符串标识，便于按名称访问

**极性示例**：
```c
// 高电平有效的开关
attr.en = 1;
set(POWER_SW_ON)  → gpio_output(num, 1)  → GPIO=HIGH → 开关闭合
set(POWER_SW_OFF) → gpio_output(num, 0)  → GPIO=LOW  → 开关断开

// 低电平有效的开关
attr.en = 0;
set(POWER_SW_ON)  → gpio_output(num, 0)  → GPIO=LOW  → 开关闭合
set(POWER_SW_OFF) → gpio_output(num, 1)  → GPIO=HIGH → 开关断开
```

### 3.2 开关结构体

```c
struct power_sw {
    bool ready;                                      // 是否已注册就绪
    struct power_sw_attr attr;                       // 开关属性
    int (*set)(struct power_sw_attr *attr, int status);  // 设置函数
    int (*get)(struct power_sw_attr *attr);          // 读取函数
    void (*free)(struct power_sw_attr *attr);        // 释放函数
};
```

**操作函数指针**：
- `set`: 设置开关状态（ON/OFF）
- `get`: 读取当前开关状态
- `free`: 释放资源（如 GPIO）

### 3.3 全局开关数组

```c
#define POWER_SW_NUMS  8  // 最多支持 8 个开关

static struct power_sw g_pwr_sw[POWER_SW_NUMS];
```

**设计考虑**：
- 固定数组大小，简单高效
- 索引访问，O(1) 复杂度
- 8 个槽位足够覆盖常见场景

---

## 4. 核心功能实现

### 4.1 开关注册

```c
int power_sw_register(int idx, struct power_sw *sw)
{
    // 参数校验
    if (!sw || !sw->set || !sw->get || !sw->free) {
        hwlog_err("register: sw/attr/ops null\n");
        return -ENODEV;
    }
    
    // 索引校验：0 <= idx < 8，且不能重复注册
    if ((idx < 0) || (idx >= POWER_SW_NUMS) || g_pwr_sw[idx].ready) {
        hwlog_err("register: idx=%d out-of-range/occupied\n", idx);
        return -EINVAL;
    }

    // 复制属性
    memcpy(&g_pwr_sw[idx].attr, &sw->attr, sizeof(g_pwr_sw[idx].attr));
    
    // 复制函数指针
    g_pwr_sw[idx].set = sw->set;
    g_pwr_sw[idx].get = sw->get;
    g_pwr_sw[idx].free = sw->free;
    
    // 标记就绪
    g_pwr_sw[idx].ready = true;
    
    // 设置默认状态
    g_pwr_sw[idx].set(&g_pwr_sw[idx].attr, 
        g_pwr_sw[idx].attr.dflt == g_pwr_sw[idx].attr.en ? 
            POWER_SW_ON : POWER_SW_OFF);

    hwlog_info("sw[%d] label:%s registered\n", idx, sw->attr.label);
    return 0;
}
```

**关键设计**：
1. **深拷贝属性**：避免外部结构体生命周期问题
2. **浅拷贝函数指针**：引用外部实现的函数
3. **初始化状态**：根据 `dflt` 和 `en` 计算初始 ON/OFF
4. **防重复注册**：检查 `ready` 标志

### 4.2 设置开关状态

```c
int power_sw_set_output(int idx, int status)
{
    // 校验索引范围
    if ((idx < 0) || (idx >= POWER_SW_NUMS) ||
        !g_pwr_sw[idx].ready || !g_pwr_sw[idx].set)
        return -EINVAL;

    hwlog_info("[set_output] %s set %s\n", g_pwr_sw[idx].attr.label,
        status == POWER_SW_ON ? "on" : "off");
    
    // 调用实现函数
    return g_pwr_sw[idx].set(&g_pwr_sw[idx].attr, status);
}
```

**通过标签设置（带去重优化）**：
```c
int power_sw_set_output_by_label(const char *label, int status, bool force)
{
    int idx;
    int cur_status;

    if (!label)
        return -EINVAL;

    // 查找索引
    idx = power_sw_get_idx_by_label(label);
    
    // 读取当前状态
    cur_status = power_sw_get_output(idx);
    
    // 去重优化：如果状态相同且非强制，则跳过
    if (!force && (status == cur_status))
        return 0;
    
    // 执行设置
    return power_sw_set_output(idx, status);
}
```

### 4.3 读取开关状态

```c
int power_sw_get_output(int idx)
{
    // 校验索引范围
    if ((idx < 0) || (idx >= POWER_SW_NUMS) ||
        !g_pwr_sw[idx].ready || !g_pwr_sw[idx].get)
        return POWER_SW_ON;  // 异常时默认返回 ON

    // 调用实现函数
    return g_pwr_sw[idx].get(&g_pwr_sw[idx].attr);
}

int power_sw_get_output_by_label(const char *label)
{
    if (!label)
        return POWER_SW_OFF;

    return power_sw_get_output(power_sw_get_idx_by_label(label));
}
```

### 4.4 GPIO 实现

#### 设置 GPIO 开关

```c
static int power_sw_set_by_gpio(struct power_sw_attr *attr, int status)
{
    int ret;

    if (!attr) {
        hwlog_err("set_by_gpio: attr null\n");
        return -EINVAL;
    }

    // 根据状态和极性计算 GPIO 输出值
    ret = gpio_direction_output(attr->num,
        status == POWER_SW_ON ? attr->en : !attr->en);
    
    // 打印日志验证
    hwlog_info("[set_by_gpio] gpio_%d %s now\n", attr->num,
        gpio_get_value(attr->num) ? "high" : "low");

    return ret;
}
```

**极性计算逻辑**：
```c
status == POWER_SW_ON ? attr->en : !attr->en

示例1（高电平有效，en=1）:
  status=ON  → gpio_output(num, 1)  → HIGH
  status=OFF → gpio_output(num, 0)  → LOW

示例2（低电平有效，en=0）:
  status=ON  → gpio_output(num, 0)  → LOW
  status=OFF → gpio_output(num, 1)  → HIGH
```

#### 读取 GPIO 开关

```c
static int power_sw_get_by_gpio(struct power_sw_attr *attr)
{
    int gpio_val;

    if (!attr) {
        hwlog_err("get_by_gpio: attr null\n");
        return POWER_SW_OFF;
    }

    // 读取 GPIO 值
    gpio_val = gpio_get_value(attr->num);
    
    // 根据极性转换为 ON/OFF
    return gpio_val == attr->en ? POWER_SW_ON : POWER_SW_OFF;
}
```

#### 释放 GPIO 资源

```c
static void power_sw_free_by_gpio(struct power_sw_attr *attr)
{
    if (!attr) {
        hwlog_err("free_by_gpio: attr null\n");
        return;
    }

    gpio_free(attr->num);
}
```

### 4.5 设备树解析与初始化

```c
static int power_sw_init_gpio(struct device_node *np)
{
    int i;
    int sw_idx;
    int gpio_count;
    struct power_sw sw;

    // 获取 GPIO 数量
    gpio_count = of_gpio_count(np);
    if (gpio_count <= 0)
        return 0;

    // 遍历每个 GPIO
    for (i = 0; i < gpio_count; i++) {
        // 1. 读取标签
        if (power_dts_read_string_index(power_dts_tag(HWLOG_TAG),
            np, "labels", i, &sw.attr.label)) {
            hwlog_err("init_gpio: parse label failed\n");
            continue;
        }
        
        // 2. 获取 GPIO 编号
        sw.attr.num = of_get_gpio(np, i);
        hwlog_info("[init_gpio] num=%d\n", sw.attr.num);
        if (!gpio_is_valid(sw.attr.num)) {
            hwlog_err("init_gpio: gpio%d invalid\n", sw.attr.num);
            continue;
        }
        
        // 3. 申请 GPIO
        if (gpio_request(sw.attr.num, sw.attr.label)) {
            hwlog_err("init_gpio: request gpio%d failed\n", sw.attr.num);
            continue;
        }
        
        // 4. 读取配置参数
        if (power_dts_read_u32_index(power_dts_tag(HWLOG_TAG),
            np, "dlfts", i, &sw.attr.dflt) ||         // 默认状态
            power_dts_read_u32_index(power_dts_tag(HWLOG_TAG),
                np, "en", i, &sw.attr.en) ||         // 使能极性
            power_dts_read_u32_index(power_dts_tag(HWLOG_TAG),
                np, "indexs", i, &sw_idx)) {          // 注册索引
            hwlog_err("init_gpio: get dflt_val/idx failed\n");
            gpio_free(sw.attr.num);
            continue;
        }
        
        // 5. 设置 GPIO 实现函数
        sw.set = power_sw_set_by_gpio;
        sw.get = power_sw_get_by_gpio;
        sw.free = power_sw_free_by_gpio;
        
        // 6. 注册开关
        if (power_sw_register(sw_idx, &sw))
            gpio_free(sw.attr.num);
    }

    return 0;
}
```

---

## 5. 典型应用场景

### 5.1 OVP 开关控制

```c
/* mixed_ovp_switch.c - 过压保护开关 */

// 检查开关是否就绪
if (!power_sw_ready(di->para[i].idx))
    continue;

// 获取开关状态
if (power_sw_get_output(di->para[i].idx) == POWER_SW_ON)
    hwlog_info("ovp switch %d is on\n", i);

// 打开 OVP 开关
if (power_sw_set_output(di->para[i].idx, POWER_SW_ON))
    hwlog_err("set ovp switch %d on failed\n", i);

// 关闭 OVP 开关
return power_sw_set_output(di->para[chsw_type].idx, POWER_SW_OFF);
```

**场景说明**：
- OVP（Over Voltage Protection）开关用于保护充电路径
- 需要根据充电模式动态切换
- 使用 `power_sw` 统一管理多个 OVP 路径

### 5.2 无线充电开关控制

```c
/* wireless_power_supply.c - 无线充电电源开关 */

// 使能无线接收开关
if (enable)
    power_sw_set_output(di->rxsw_index, POWER_SW_ON);
else
    power_sw_set_output(di->rxsw_index, POWER_SW_OFF);

// 使能无线发射 SC 开关
if (enable)
    power_sw_set_output(di->scsw_index, POWER_SW_ON);
else
    power_sw_set_output(di->scsw_index, POWER_SW_OFF);
```

**应用场景**：
```
无线充电接收：
    ↓
power_sw_set_output(rxsw_index, ON)
    ↓
RX 开关闭合，线圈接入充电IC
    ↓
开始无线充电

无线反向充电：
    ↓
power_sw_set_output(scsw_index, ON)
    ↓
SC（Switch Capacitor）开关闭合
    ↓
电池通过升压为 TX 线圈供电
```

### 5.3 通过标签访问（简化代码）

```c
// 传统方式（需要知道索引）
power_sw_set_output(0, POWER_SW_ON);  // 0 是什么？不直观

// 标签方式（自描述）
power_sw_set_output_by_label("charger_ovp", POWER_SW_ON, false);
power_sw_set_output_by_label("wireless_rx_sw", POWER_SW_ON, true);

// 带去重优化
power_sw_set_output_by_label("vbus_aux_sw", POWER_SW_ON, false);
// 如果已经是 ON，跳过操作，节省 GPIO 访问
```

---

## 6. 设备树配置示例

### 6.1 配置格式

```dts
power_sw {
    compatible = "huawei,power_sw";
    status = "ok";
    
    /* GPIO 列表（按索引顺序） */
    gpios = <&gpio12 5 0>,    // GPIO12_5
            <&gpio12 6 0>,    // GPIO12_6
            <&gpio15 2 0>,    // GPIO15_2
            <&gpio15 3 0>;    // GPIO15_3
    
    /* 标签列表（与 GPIO 一一对应） */
    labels = "charger_ovp",
             "wireless_rx_sw",
             "wireless_sc_sw",
             "vbus_aux_sw";
    
    /* 默认状态列表（0=OFF初始化, 1=ON初始化） */
    dlfts = <0>,  // charger_ovp 默认关闭
            <0>,  // wireless_rx_sw 默认关闭
            <0>,  // wireless_sc_sw 默认关闭
            <1>;  // vbus_aux_sw 默认开启
    
    /* 使能极性列表（0=低电平有效, 1=高电平有效） */
    en = <1>,     // charger_ovp 高电平打开
         <1>,     // wireless_rx_sw 高电平打开
         <0>,     // wireless_sc_sw 低电平打开
         <1>;     // vbus_aux_sw 高电平打开
    
    /* 注册索引列表（0-7） */
    indexs = <0>, <1>, <2>, <3>;
};
```

### 6.2 配置参数说明

| 参数 | 类型 | 说明 | 示例 |
|------|------|------|------|
| `gpios` | GPIO 数组 | GPIO 资源列表 | `<&gpio12 5 0>` |
| `labels` | 字符串数组 | 开关名称标签 | `"charger_ovp"` |
| `dlfts` | u32 数组 | 默认状态（0/1） | `<0>` = 初始关闭 |
| `en` | u32 数组 | 使能极性（0/1） | `<1>` = 高电平有效 |
| `indexs` | u32 数组 | 注册索引（0-7） | `<0>` = 注册到槽位 0 |

### 6.3 初始化映射示例

```
设备树配置：
gpios[0]   = GPIO12_5
labels[0]  = "charger_ovp"
dlfts[0]   = 0
en[0]      = 1
indexs[0]  = 0

初始化后：
g_pwr_sw[0].attr.num   = GPIO12_5
g_pwr_sw[0].attr.label = "charger_ovp"
g_pwr_sw[0].attr.dflt  = 0
g_pwr_sw[0].attr.en    = 1
g_pwr_sw[0].set        = power_sw_set_by_gpio
g_pwr_sw[0].get        = power_sw_get_by_gpio
g_pwr_sw[0].free       = power_sw_free_by_gpio
g_pwr_sw[0].ready      = true

初始状态：
dflt=0, en=1 → 初始设置为 OFF
power_sw_set_by_gpio(&attr, POWER_SW_OFF)
  → gpio_output(GPIO12_5, 0) → GPIO=LOW
```

---

## 7. 设计特点与优势

### 7.1 面向接口编程（OOP 思想）

```c
struct power_sw {
    // 数据成员
    bool ready;
    struct power_sw_attr attr;
    
    // 方法（虚函数）
    int (*set)(struct power_sw_attr *attr, int status);
    int (*get)(struct power_sw_attr *attr);
    void (*free)(struct power_sw_attr *attr);
};
```

**优势**：
- ✅ 多态性：不同实现（GPIO/I2C）使用相同接口
- ✅ 可扩展：新增实现无需修改调用者代码
- ✅ 解耦合：调用者不关心底层实现

### 7.2 策略模式（Strategy Pattern）

```
┌─────────────────────────────────────────┐
│ Context: power_sw 框架                  │
│  - 持有 strategy (set/get/free)         │
│  - 调用 strategy->set()                 │
└─────────────────────────────────────────┘
                   ↓
     ┌─────────────┴─────────────┐
     ↓                           ↓
┌─────────────┐          ┌─────────────┐
│ Strategy A  │          │ Strategy B  │
│ GPIO 实现   │          │ I2C 实现    │
│             │          │             │
│ set_by_gpio │          │ set_by_i2c  │
│ get_by_gpio │          │ get_by_i2c  │
└─────────────┘          └─────────────┘
```

**切换实现**：
```c
// GPIO 实现
sw.set = power_sw_set_by_gpio;
sw.get = power_sw_get_by_gpio;
sw.free = power_sw_free_by_gpio;

// I2C 实现（假设）
sw.set = power_sw_set_by_i2c;
sw.get = power_sw_get_by_i2c;
sw.free = power_sw_free_by_i2c;

// 调用者无需改变
power_sw_set_output(idx, POWER_SW_ON);  // 自动路由到正确实现
```

### 7.3 注册-发现机制

```c
// 生产者（硬件驱动）
struct power_sw my_switch = {
    .attr.label = "custom_switch",
    .set = my_set_function,
    .get = my_get_function,
    .free = my_free_function,
};
power_sw_register(4, &my_switch);

// 消费者（应用模块）
power_sw_set_output_by_label("custom_switch", POWER_SW_ON, false);
```

**优势**：
- ✅ 松耦合：生产者和消费者无需直接引用
- ✅ 晚绑定：运行时动态发现和绑定
- ✅ 插件化：驱动可独立加载

### 7.4 标签访问简化代码

```c
// 传统方式：需要维护索引宏定义
#define CHARGER_OVP_IDX  0
#define WIRELESS_RX_IDX  1
power_sw_set_output(CHARGER_OVP_IDX, POWER_SW_ON);

// 标签方式：自描述，易维护
power_sw_set_output_by_label("charger_ovp", POWER_SW_ON, false);
```

**优势**：
- ✅ 可读性：代码自解释
- ✅ 灵活性：修改索引无需改代码
- ✅ 安全性：编译期发现拼写错误

---

## 8. 性能分析

### 8.1 时间复杂度

| 操作 | 复杂度 | 说明 |
|------|--------|------|
| `power_sw_set_output(idx, status)` | O(1) | 数组索引直接访问 |
| `power_sw_get_output(idx)` | O(1) | 数组索引直接访问 |
| `power_sw_set_output_by_label(label, status)` | O(n) | 需要遍历查找（n≤8）|
| `power_sw_register(idx, sw)` | O(1) | 直接赋值 |

**优化建议**：
- 频繁访问的场景使用索引访问
- 初始化或低频场景使用标签访问

### 8.2 空间开销

```c
struct power_sw {
    bool ready;           // 1 byte
    struct power_sw_attr attr {
        void *dev;        // 8 bytes (64-bit)
        int num;          // 4 bytes
        int dflt;         // 4 bytes
        int en;           // 4 bytes
        const char *label;// 8 bytes
    };                    // 28 bytes
    int (*set)(...);      // 8 bytes
    int (*get)(...);      // 8 bytes
    void (*free)(...);    // 8 bytes
};                        // ~53 bytes

g_pwr_sw[8]: 53 * 8 = 424 bytes
```

**内存占用**：< 0.5 KB，极小

### 8.3 调用开销

```c
// 典型调用链
power_sw_set_output(idx, status)
    ↓ 函数调用 (~10 cycles)
g_pwr_sw[idx].set(&attr, status)
    ↓ 函数指针调用 (~20 cycles)
power_sw_set_by_gpio(&attr, status)
    ↓ 函数调用 (~10 cycles)
gpio_direction_output(num, val)
    ↓ GPIO 硬件操作 (~1000 cycles)
```

**总开销**：< 50 CPU cycles（相比 GPIO 操作可忽略）

---

## 9. 潜在问题与改进建议

### 9.1 并发安全

**当前问题**：
- 无锁保护，多线程同时访问可能冲突
- 设置和读取非原子操作

**改进建议**：
```c
struct power_sw {
    bool ready;
    struct mutex lock;  // 新增：互斥锁
    struct power_sw_attr attr;
    // ... 其他成员
};

int power_sw_set_output(int idx, int status)
{
    int ret;
    
    if ((idx < 0) || (idx >= POWER_SW_NUMS) || !g_pwr_sw[idx].ready)
        return -EINVAL;

    mutex_lock(&g_pwr_sw[idx].lock);  // 加锁
    ret = g_pwr_sw[idx].set(&g_pwr_sw[idx].attr, status);
    mutex_unlock(&g_pwr_sw[idx].lock);  // 解锁
    
    return ret;
}
```

### 9.2 标签查找优化

**当前问题**：
- 线性查找，O(n) 复杂度
- 每次调用都遍历

**改进建议**：
```c
// 方案1: 哈希表
static struct hlist_head g_pwr_sw_hash[16];  // 简单哈希

// 方案2: 缓存最近查找
static int g_last_idx = -1;
static const char *g_last_label = NULL;

int power_sw_get_idx_by_label(const char *label)
{
    // 快速路径：检查缓存
    if (g_last_label && strcmp(g_last_label, label) == 0)
        return g_last_idx;
    
    // 慢速路径：遍历查找
    for (idx = 0; idx < POWER_SW_NUMS; idx++) {
        if (strstr(g_pwr_sw[idx].attr.label, label)) {
            g_last_idx = idx;
            g_last_label = label;
            return idx;
        }
    }
    return POWER_SW_NUMS;
}
```

### 9.3 错误处理增强

**当前问题**：
- `get` 函数出错时返回 `POWER_SW_ON`，可能误导
- 无法区分"开关开启"和"查询失败"

**改进建议**：
```c
// 使用负值表示错误
#define POWER_SW_ON     1
#define POWER_SW_OFF    0
#define POWER_SW_ERROR  -1

int power_sw_get_output(int idx)
{
    if ((idx < 0) || (idx >= POWER_SW_NUMS))
        return POWER_SW_ERROR;
    
    if (!g_pwr_sw[idx].ready || !g_pwr_sw[idx].get)
        return POWER_SW_ERROR;

    return g_pwr_sw[idx].get(&g_pwr_sw[idx].attr);
}

// 调用者检查
int status = power_sw_get_output(idx);
if (status == POWER_SW_ERROR) {
    hwlog_err("failed to get switch status\n");
    return -EIO;
}
```

---

## 10. 调试方法

### 10.1 日志追踪

```bash
# 使能日志
echo 8 > /proc/sys/kernel/printk

# 过滤 power_sw 日志
dmesg | grep power_sw

# 典型日志输出
[  xxx.xxx] power_sw: sw[0] label:charger_ovp registered
[  xxx.xxx] power_sw: [set_output] charger_ovp set on
[  xxx.xxx] power_sw: [set_by_gpio] gpio_123 high now
[  xxx.xxx] power_sw: [set_output] wireless_rx_sw set off
[  xxx.xxx] power_sw: [set_by_gpio] gpio_124 low now
```

### 10.2 debugfs 接口（建议新增）

```c
// 建议实现的调试接口
static ssize_t power_sw_dbg_status_show(void *dev_data, char *buf, size_t size)
{
    int i;
    ssize_t len = 0;
    
    len += scnprintf(buf + len, size - len, "Power Switch Status:\n");
    len += scnprintf(buf + len, size - len, "Idx  Ready  Label            GPIO  State\n");
    len += scnprintf(buf + len, size - len, "---  -----  ---------------  ----  -----\n");
    
    for (i = 0; i < POWER_SW_NUMS; i++) {
        if (!g_pwr_sw[i].ready)
            continue;
        
        len += scnprintf(buf + len, size - len, "%-3d  %-5s  %-15s  %-4d  %s\n",
            i,
            g_pwr_sw[i].ready ? "true" : "false",
            g_pwr_sw[i].attr.label,
            g_pwr_sw[i].attr.num,
            power_sw_get_output(i) == POWER_SW_ON ? "ON" : "OFF");
    }
    
    return len;
}

// 查看所有开关状态
cat /sys/kernel/debug/hwpower/power_sw/status

// 输出示例
Power Switch Status:
Idx  Ready  Label            GPIO  State
---  -----  ---------------  ----  -----
0    true   charger_ovp      123   ON
1    true   wireless_rx_sw   124   OFF
2    true   wireless_sc_sw   125   OFF
3    true   vbus_aux_sw      126   ON
```

### 10.3 GPIO 状态验证

```bash
# 查看 GPIO 状态
cat /sys/kernel/debug/gpio | grep -E "charger_ovp|wireless"

# 输出示例
gpio-123 (charger_ovp      ) out hi
gpio-124 (wireless_rx_sw   ) out lo
gpio-125 (wireless_sc_sw   ) out lo
gpio-126 (vbus_aux_sw      ) out hi
```

---

## 11. 与其他模块对比

| 模块 | 功能 | 抽象层次 | 应用场景 |
|------|------|----------|----------|
| **power_sw** | **通用开关抽象** | **高** | **各种电源开关** |
| charger_channel | 充电通道切换 | 中 | USB/无线输入切换 |
| dischg_boost | 放电路径切换 | 中 | 直连/升压切换 |
| power_gpio | GPIO 封装 | 低 | 原始 GPIO 操作 |

**power_sw 的独特价值**：
- ✅ 更高抽象：不仅限于 GPIO
- ✅ 统一管理：集中注册和发现
- ✅ 灵活扩展：支持多种实现方式

---

## 12. 总结

### 12.1 核心价值

`power_sw` 是华为充电框架中的**电源开关抽象层**，提供了：

1. **统一接口**：ON/OFF 简单操作，屏蔽底层差异
2. **多态实现**：支持 GPIO、I2C 等多种硬件
3. **即插即用**：设备树配置，无需代码改动
4. **集中管理**：全局注册，方便查找和控制

### 12.2 技术亮点

| 特性 | 实现 | 优势 |
|------|------|------|
| 面向接口编程 | 函数指针 | 多态、可扩展 |
| 策略模式 | set/get/free ops | 运行时切换实现 |
| 注册-发现 | 全局数组 + 标签 | 松耦合、晚绑定 |
| 双访问方式 | 索引 + 标签 | 性能 vs 可读性 |
| 极性抽象 | en 参数 | 统一高低电平逻辑 |

### 12.3 适用场景

✅ **适合**：
- 需要统一管理的开关（> 3个）
- 可能切换实现方式的开关
- 多模块共享的开关资源

❌ **不适合**：
- 单一、固定的开关
- 性能极端敏感的场景
- 不需要抽象的简单 GPIO

### 12.4 最佳实践

1. **使用标签访问**：提高代码可读性
   ```c
   power_sw_set_output_by_label("charger_ovp", POWER_SW_ON, false);
   ```

2. **设置默认状态**：确保系统初始化安全
   ```dts
   dlfts = <0>;  // 关键开关默认关闭
   ```

3. **验证注册成功**：调用前检查 `ready`
   ```c
   if (!power_sw_ready(idx))
       return -ENODEV;
   ```

4. **合理使用 force 参数**：避免冗余操作
   ```c
   power_sw_set_output_by_label(label, status, false);  // 去重
   ```

---

## 13. 参考资料

- power_sw.c
- power_sw.h
- 调用者示例：
  - mixed_ovp_switch.c
  - wireless_power_supply.c
