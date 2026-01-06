---
outline: deep
---
# 华为电池核心之battery_ocv模块
## 一、模块概述
[battery_ocv.c]是华为电源管理框架中的电池开路电压（OCV）管理驱动，核心功能：

- OCV-SOC 曲线表管理（电压-电量映射）
- 支持动态更新 OCV 表（学习优化）
- 双表机制（默认表 + 动态表）
- 电量校准基础

## 二、核心数据结构
### 2.1 设备结构体
```c
struct battery_ocv_dev {
    struct device *dev;
    spinlock_t data_lock;               // 自旋锁（保护动态表）
    struct ocv_table *dynamic_ocv_table; // 动态 OCV 表（运行时学习）
    int dynamic_table_size;             // 动态表大小
    struct ocv_table *default_table;    // 默认 OCV 表（DTS 配置）
    int default_table_size;             // 默认表大小
};
```
### 2.2 OCV表项结构
```c
struct ocv_table {
    int cap;        // 电量百分比 (-1~100)
    int voltage;    // 对应的开路电压 (mV)
};
```
### 2.3 特殊电量定义
```c
BATTERY_OCV_SHUTDOWN_CAPACITY   (-1)   // 关机电量点
BATTERY_OCV_CUTOFF_CAPACITY     0      // 截止电压点
BATTERY_OCV_ONE_PERCENT_CAPACITY 1     // 1% 电量点
```

## 三、关键功能模块
### 3.1 OCV查询接口
核心算法：
```c
int battery_ocv_get_ocv_by_cap(int cap, int *ocv)
{
    // 1. 优先查询动态表（学习优化后的表）
    spin_lock(&di->data_lock);
    ret = battery_ocv_get_ocv_from_table(di->dynamic_ocv_table,
        di->dynamic_table_size, cap, ocv);
    spin_unlock(&di->data_lock);
    
    // 2. 动态表未命中，查询默认表
    if (ret)
        return battery_ocv_get_ocv_from_table(di->default_table,
            di->default_table_size, cap, ocv);
    
    return 0;
}
```
表查询逻辑：
```c
static int battery_ocv_get_ocv_from_table(struct ocv_table *table,
    int size, int cap, int *ocv)
{
    // 线性查找匹配电量值
    for (i = 0; i < size; i++) {
        if (table[i].cap == cap) {
            *ocv = table[i].voltage;  // 找到匹配
            return 0;
        }
    }
    return -EINVAL;  // 未找到
}
```
调用示例：
```c
int ocv = 0;
int cap = 50;  // 查询 50% 电量对应的 OCV

if (battery_ocv_get_ocv_by_cap(cap, &ocv) == 0) {
    hwlog_info("cap=%d, ocv=%d mV\n", cap, ocv);
}
```

### 3.2 动态OCV表更新
```c
battery_ocv_update_ocv_table(struct ocv_table *table, int size) {
    1. 分配临时表内存
       temp_table = kzalloc(sizeof(struct ocv_table) * size, GFP_KERNEL);
    
    2. 拷贝新表数据
       memcpy_s(temp_table, table, ...);
    
    3. 按电量值排序（从小到大）
       sort(temp_table, size, ..., battery_ocv_cmp, NULL);
    
    4. 电压单调性修正（防止电压倒挂）
       for (i = 0; i < size - 1; i++) {
           if (temp_table[i + 1].voltage < temp_table[i].voltage)
               temp_table[i + 1].voltage = temp_table[i].voltage;
       }
    
    5. 替换动态表
       spin_lock(&di->data_lock);
       kfree(di->dynamic_ocv_table);
       di->dynamic_ocv_table = temp_table;
       di->dynamic_table_size = size;
       spin_unlock(&di->data_lock);
    
    6. 发送更新事件通知
       power_event_bnc_notify(POWER_BNT_BATTERY, 
           POWER_NE_BATTERY_OCV_CHANGE, NULL);
}
```
排序比较函数
```c
static int battery_ocv_cmp(const void *a, const void *b)
{
    const struct ocv_table *x = a;
    const struct ocv_table *y = b;
    
    return x->cap - y->cap;  // 按电量升序排列
}
```
电压单调性修正示例：
原始数据（按电量排序后）:
  cap=0,  voltage=3000
  cap=10, voltage=3500
  cap=20, voltage=3450  ← 电压倒挂
  cap=30, voltage=3600

修正后:
  cap=0,  voltage=3000
  cap=10, voltage=3500
  cap=20, voltage=3500  ← 修正为前一点电压
  cap=30, voltage=3600

### 3.3 sysfs动态表更新接口
字符串解析逻辑：
```c
battery_ocv_parse_dynamic_ocv_table(char *buf) {
    // 期望格式: "-1@3000,0@3100,1@3200,..."
    // 格式说明: "电量@电压,电量@电压,..."
    
    while (tmp1 = strsep(&buf, ",")) {
        // 分割 "@" 符号
        tmp2 = strsep(&tmp1, "@");
        
        // tmp2 = 电量值
        kstrtoint(tmp2, 10, &table[count].cap);
        
        // tmp1 = 电压值
        kstrtoint(tmp1, 10, &table[count].voltage);
        
        count++;
    }
    
    // 调用更新函数
    battery_ocv_update_ocv_table(table, count);
}
```
使用示例：

```sh
# 更新 OCV 表（关机点到 100%）
echo "-1@2900,0@3000,1@3100,10@3500,50@3800,100@4200" > \
    /sys/class/hw_power/battery/battery_ocv/update_ocv_table

# 日志输出（验证）
dmesg | grep battery_ocv
# table[0] -1 2900
# table[1] 0 3000
# table[2] 1 3100
# table[3] 10 3500
# table[4] 50 3800
# table[5] 100 4200
```
### 3.4 DTS默认表解析
解析流程：
```c
battery_ocv_parse_ocv_table(struct device_node *np, 
    struct battery_ocv_dev *di) {
    
    1. 从 DTS 读取二维数组
       len = power_dts_read_string_array("ocv_table", idata, 
           DEFAULT_TABLE_MAX_SIZE, BAT_OCV_TABLE_END);
    
    2. 计算行数
       len /= BAT_OCV_TABLE_END;  // 每行 2 列 (cap, voltage)
    
    3. 分配默认表内存
       di->default_table = kzalloc(sizeof(struct ocv_table) * len, ...);
    
    4. 填充表数据
       for (row = 0; row < len; row++) {
           col = row * 2 + 0;  // 电量列
           di->default_table[row].cap = idata[col];
           
           col = row * 2 + 1;  // 电压列
           di->default_table[row].voltage = idata[col];
       }
    
    5. 保存表大小
       di->default_table_size = len;
}
```
DTS 配置示例：
```
battery_ocv {
    compatible = "huawei,battery_ocv";
    
    /* OCV 表: 电量, 电压 (mV) */
    ocv_table = <
        /* cap  voltage */
        -1     2900      // 关机电压
        0      3000      // 截止电压
        1      3100      // 1% 电量
        10     3500
        20     3650
        30     3700
        40     3750
        50     3800
        60     3850
        70     3900
        80     3950
        90     4050
        95     4150
        100    4200      // 满电电压
    >;
};
```

### 3.5 sysfs接口实现
节点定义：
```c
static struct power_sysfs_attr_info battery_ocv_sysfs_field_tbl[] = {
    power_sysfs_attr_wo(battery_ocv, 0220,
        BATTERY_OCV_SYSFS_UPDATE_OCV_TABLE, update_ocv_table),
};
```
Store 函数：
```c
static ssize_t battery_ocv_sysfs_store(struct device *dev,
    struct device_attribute *attr, const char *buf, size_t count)
{
    switch (info->name) {
    case BATTERY_OCV_SYSFS_UPDATE_OCV_TABLE:
        // 拷贝用户输入到临时缓冲区
        snprintf_s(buff, BAT_OCV_BUF_MAX_SIZE, 
            BAT_OCV_BUF_MAX_SIZE - 1, "%s", buf);
        
        // 解析并更新 OCV 表
        if (battery_ocv_parse_dynamic_ocv_table(buff))
            return -EINVAL;
        break;
    }
    return count;
}
```
节点路径：
> /sys/class/hw_power/battery/battery_ocv/update_ocv_table (WO, 0220)

## 四、初始化流程
```
battery_ocv_probe()
├── 1. 分配设备结构体
│   └── devm_kzalloc(sizeof(struct battery_ocv_dev))
├── 2. 解析 DTS 配置
│   └── battery_ocv_parse_ocv_table()
│       ├── 读取 ocv_table 数组
│       ├── 分配 default_table 内存
│       └── 填充默认表数据
├── 3. 初始化自旋锁
│   └── spin_lock_init(&di->data_lock)
├── 4. 创建 Sysfs 节点
│   └── battery_ocv_sysfs_create_group()
│       └── /sys/class/hw_power/battery/battery_ocv/
├── 5. 设置全局指针
│   └── g_battery_ocv_dev = di
└── 6. 注册平台设备
    └── platform_set_drvdata(pdev, di)
```
## 五、典型应用场景
### 5.1 电量计初始化校准
```c
// 开机时，根据开路电压校准 SOC
int battery_init_calibration(void)
{
    int ocv_measured = 3750;  // 库仑计测量的 OCV
    int soc = 0;
    
    // 查找最接近的电量值
    for (cap = 0; cap <= 100; cap++) {
        int ocv = 0;
        if (battery_ocv_get_ocv_by_cap(cap, &ocv) == 0) {
            if (abs(ocv - ocv_measured) < 50) {  // 50mV 容差
                soc = cap;
                break;
            }
        }
    }
    
    coul_interface_set_battery_soc(soc);
    return 0;
}
```
### 5.2 低电量电压校准
```c
// 电池接近 1% 时，使用 OCV 校准
void battery_low_voltage_calibration(void)
{
    int ocv_1p = 0;
    int ocv_0p = 0;
    int voltage_now;
    
    // 获取 1% 和 0% 的 OCV
    battery_ocv_get_ocv_by_cap(BATTERY_OCV_ONE_PERCENT_CAPACITY, &ocv_1p);
    battery_ocv_get_ocv_by_cap(BATTERY_OCV_CUTOFF_CAPACITY, &ocv_0p);
    
    voltage_now = coul_interface_get_battery_voltage();
    
    if (voltage_now < ocv_1p) {
        // 强制校准到 1%
        coul_interface_set_battery_soc(1);
    }
}
```

### 5.3 关机电压判断
```c
// 判断是否达到关机电压
bool is_shutdown_voltage(void)
{
    int shutdown_ocv = 0;
    int voltage_now;
    
    battery_ocv_get_ocv_by_cap(BATTERY_OCV_SHUTDOWN_CAPACITY, 
        &shutdown_ocv);
    
    voltage_now = coul_interface_get_battery_voltage();
    
    return (voltage_now < shutdown_ocv);
}
```
### 5.4 电池老化后动态更新OCV表
```sh
#!/system/bin/sh
# 电池学习完成后更新 OCV 表

# 从学习数据生成新的 OCV 表
NEW_TABLE="-1@2850,0@2950,1@3050,10@3450,50@3750,100@4150"

# 更新到驱动
echo "$NEW_TABLE" > /sys/class/hw_power/battery/battery_ocv/update_ocv_table

# 验证更新成功
dmesg | tail -20 | grep battery_ocv
```

## 六、关键算法原理
### 6.1 双表机制优势
|表类型	|来源	|优先级	|用途|
|:----:|:-----:|:------:|:-----:|
|默认表|DTS配置	|低	|新电池出厂标定值|
|动态表|运行时学习	|高	|电池老化后的实测值|

查询优先级：
```
battery_ocv_get_ocv_by_cap()
    ↓
1. 查询动态表 (如果存在)
    ├─ 命中 → 返回学习后的 OCV
    └─ 未命中 ↓
2. 查询默认表
    ├─ 命中 → 返回出厂标定 OCV
    └─ 未命中 → 返回错误
```
### 6.2 电压单调性保证
**为什么需要单调性？**
```
电池放电曲线特性：
- 电量降低 → 电压降低（单调递减）
- 如果电压倒挂，SOC 计算会出现跳变
```
修正算法：
```c
// 确保后一点电压 ≥ 前一点电压
for (i = 0; i < size - 1; i++) {
    if (temp_table[i + 1].voltage < temp_table[i].voltage)
        temp_table[i + 1].voltage = temp_table[i].voltage;
}
```
修正示例：
```
修正前（错误）:
cap=10, voltage=3500
cap=20, voltage=3450 ← 电压倒挂！
cap=30, voltage=3600

修正后（正确）:
cap=10, voltage=3500
cap=20, voltage=3500 ← 修正为 3500
cap=30, voltage=3600
```
### 6.3 线程安全保护
```c
// 动态表访问使用自旋锁保护
spin_lock(&di->data_lock);
ret = battery_ocv_get_ocv_from_table(di->dynamic_ocv_table, ...);
spin_unlock(&di->data_lock);
```
保护场景：
- 读操作：`battery_ocv_get_ocv_by_cap()` 并发查询
- 写操作：`battery_ocv_update_ocv_table()` 更新表
- 防止：读到一半更新导致的数据不一致

## 七、OCV-SOC曲线特性
典型锂电池 OCV-SOC 曲线：
```
电压(mV)
  4200 ┤                    ╭─────── 100%
       │                ╭───╯
  4100 ┤            ╭───╯
       │        ╭───╯
  4000 ┤    ╭───╯               中间平台区
       │╭───╯                   (斜率小，难精确估算 SOC)
  3900 ┼╯
       │
  3800 ┤
       │                        快速下降区
  3700 ┤                        (斜率大，容易估算 SOC)
       │
  3600 ┤
       │
  3500 ┤
       │    ╰───╮
  3400 ┤        ╰───╮          低电量区
       │            ╰───╮      (电压快速下降)
  3300 ┤                ╰───╮
       │                    ╰─── 1%
  3200 ┤
  3100 ┤
  3000 ┤──────────────────────── 0% (截止电压)
  2900 ┤──────────────────────── -1% (关机电压)
       └────────────────────────────
      -1  0   10  20  30  40  50  60  70  80  90 100
                     电量 (%)

```
**关键电量点：**

|电量 (cap)	|电压 (典型值)	|用途|
|:-----:|:-----:|:-----:|
|-1	|2900mV	|关机电压（系统强制关机）|
|0	|3000mV	|截止电压（电池保护）|
|1	|3100mV	|低电量警告|
|10-90	|3500-4050mV	|正常使用区间|
|100	|4200mV	|满电电压|

## 八、事件通知机制
```c
// OCV 表更新后发送事件
power_event_bnc_notify(POWER_BNT_BATTERY, 
    POWER_NE_BATTERY_OCV_CHANGE, NULL);
```
监听模块：
```c
// 其他模块监听 OCV 变化
static int battery_ui_capacity_event_notifier(struct notifier_block *nb,
    unsigned long event, void *data)
{
    switch (event) {
    case POWER_NE_BATTERY_OCV_CHANGE:
        // OCV 表已更新，重新校准电量
        recalculate_ui_capacity();
        break;
    }
    return NOTIFY_OK;
}
```
## 九、内存管理
### 9.1 默认表
```c
// 静态分配（驱动生命周期）
di->default_table = kzalloc(sizeof(struct ocv_table) * len, GFP_KERNEL);
```

### 9.2 动态表
```c
// 动态分配/释放（可更新）
temp_table = kzalloc(sizeof(struct ocv_table) * size, GFP_KERNEL);

spin_lock(&di->data_lock);
kfree(di->dynamic_ocv_table);  // 释放旧表
di->dynamic_ocv_table = temp_table;  // 替换为新表
spin_unlock(&di->data_lock);
```

## 十、调试方法
### 10.1 查看日志
```sh
dmesg | grep battery_ocv

# 示例输出
battery_ocv: default table[0] -1 2900
battery_ocv: default table[1] 0 3000
battery_ocv: default table[2] 1 3100
...
battery_ocv: table[5] 100 4200
```

### 10.2 动态更新测试
```sh
# 更新 OCV 表（模拟电池老化）
echo "-1@2850,0@2950,1@3050,50@3750,100@4150" > \
    /sys/class/hw_power/battery/battery_ocv/update_ocv_table

# 验证更新
dmesg | tail -20
```

### 10.2 验证查询功能
```c
// 内核模块中验证
int ocv = 0;
battery_ocv_get_ocv_by_cap(50, &ocv);
hwlog_info("50%% capacity OCV = %d mV\n", ocv);
```

## 十一、与其他模块的交互
```
battery_ocv.c
    ↑ (查询 OCV)
    │
├── battery_ui_capacity  (UI 电量校准)
├── coul_interface       (库仑计 SOC 初始化)
├── battery_soh          (健康度计算)
└── battery_fault        (欠压判断)
```

## 十二、关键共定义
```
DEFAULT_TABLE_MAX_SIZE   16    // DTS 默认表最大行数
OCV_TABLE_MAX_SIZE       128   // Sysfs 动态表最大行数
BAT_OCV_BUF_MAX_SIZE     256   // Sysfs 输入缓冲区大小
BAT_OCV_TABLE_END        2     // 表列数（电量+电压）
```

## 十三、总结
`battery_ocv` 模块 是电池电量估算的基础模块，通过 OCV-SOC 曲线表提供电压到电量的精确映射，支持运行时学习优化，保证电池老化后电量估算的准确性。其双表机制和电压单调性保证算法是核心亮点。