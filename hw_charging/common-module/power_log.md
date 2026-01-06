---
outline: deep
---

# Power Log 模块分析

## 1. 模块定位与核心价值

### 1.1 模块定位
**power_log** 是华为MATE X5电源管理子系统中的**统一日志收集框架**，为多达70+种电源设备（电池计量芯片、充电IC、直充IC等）提供**标准化的日志输出接口**。

### 1.2 核心价值
1. **统一日志接口**：为所有电源设备提供一致的日志注册和输出机制
2. **灵活的设备选择**：支持查看单个设备或所有设备的日志
3. **结构化输出**：区分日志表头（字段说明）和日志内容（实际数据）
4. **多设备并发支持**：支持同一型号芯片的多路实例（如3路直充IC）
5. **调试友好**：通过sysfs节点提供用户空间访问接口

### 1.3 典型应用场景
- **工厂测试**：批量读取所有设备状态进行质检
- **问题定位**：快速获取特定设备的详细寄存器/参数信息
- **现场调试**：通过adb shell实时查看设备运行状态
- **日志归档**：定期收集设备运行日志用于后续分析

---

## 2. 系统架构

### 2.1 整体架构图
```
┌─────────────────────────────────────────────────────────────┐
│                      Userspace (adb shell)                  │
│  echo "bq25970" > /sys/class/hw_power/power_log/dev_id     │
│  cat /sys/class/hw_power/power_log/head                     │
│  cat /sys/class/hw_power/power_log/content                  │
└────────────────────────┬────────────────────────────────────┘
                         │ sysfs interface
┌────────────────────────┴────────────────────────────────────┐
│                    power_log Core Layer                     │
│  ┌──────────────┐   ┌──────────────┐   ┌──────────────┐   │
│  │ Device ID    │   │ Log Merger   │   │ Ops Manager  │   │
│  │ Mapper       │   │ (4KB Buffer) │   │ (70+ slots)  │   │
│  └──────────────┘   └──────────────┘   └──────────────┘   │
└────────────────────────┬────────────────────────────────────┘
                         │ power_log_ops_register()
┌────────────────────────┴────────────────────────────────────┐
│                  Device Driver Layer                        │
│  ┌────────────┐  ┌────────────┐  ┌────────────┐           │
│  │  bq25970   │  │  rt9759    │  │  cw2217    │  ...      │
│  │ (直充IC)    │  │ (直充IC)    │  │ (电量计)    │           │
│  └────────────┘  └────────────┘  └────────────┘           │
│   dump_log_head()  dump_log_head()  dump_log_head()       │
│   dump_log_content() dump_log_content() dump_log_content() │
└─────────────────────────────────────────────────────────────┘
```

### 2.2 设计理念
- **注册-回调模式**：各设备驱动主动注册日志回调函数
- **按需输出**：支持单设备精准查询或全设备批量输出
- **两级日志**：表头（head）描述字段含义，内容（content）输出实际数值
- **互斥保护**：使用两个mutex分别保护设备ID切换和日志缓冲区

---

## 3. 核心数据结构

### 3.1 设备操作接口
```c
struct power_log_ops {
    const char *dev_name;               // 设备名称（如"bq25970"）
    void *dev_data;                     // 设备私有数据指针
    int (*dump_log_head)(char *buf, int size, void *dev_data);
        // 输出日志表头（字段说明）
    int (*dump_log_content)(char *buf, int size, void *dev_data);
        // 输出日志内容（实际数据）
};
```

**关键字段说明**：
- `dev_name`：必须与预定义的设备ID表（g_power_log_device_id_table）匹配
- `dump_log_head`：典型输出如"Voltage(mV) Current(mA) Temp(°C)"
- `dump_log_content`：典型输出如"4200 1500 35"

### 3.2 核心管理结构
```c
struct power_log_dev {
    struct device *dev;                          // sysfs设备节点
    int dev_id;                                  // 当前选中的设备ID
    struct mutex log_lock;                       // 日志缓冲区锁
    struct mutex devid_lock;                     // 设备ID切换锁
    char log_buf[POWER_LOG_MAX_SIZE];            // 临时日志缓冲区（4KB）
    unsigned int total_ops;                      // 已注册的设备数量
    struct power_log_ops *ops[POWER_LOG_DEVICE_ID_END];
        // 设备操作函数指针数组（70+插槽）
};
```

**关键字段说明**：
- `log_buf`：作为中转缓冲区，避免直接向sysfs buffer写入造成溢出
- `total_ops`：用于统计已注册设备数量，初始化时打印便于排查遗漏
- `ops[]`：数组下标即为设备ID，直接索引无需遍历查找

### 3.3 设备ID枚举（部分）
```c
enum power_log_device_id {
    // 电池相关
    POWER_LOG_DEVICE_ID_SERIES_BATT,      // 串联电池
    POWER_LOG_DEVICE_ID_SERIES_CAP,       // 串联电容
    POWER_LOG_DEVICE_ID_BATT_INFO,        // PMIC电池信息
    
    // 电量计芯片
    POWER_LOG_DEVICE_ID_RT9426,           // Richtek RT9426
    POWER_LOG_DEVICE_ID_CW2217,           // CellWise CW2217
    POWER_LOG_DEVICE_ID_SH366101,         // SINO SH366101
    
    // 普通充电IC
    POWER_LOG_DEVICE_ID_BQ25892,          // TI BQ25892 (5V/9V)
    POWER_LOG_DEVICE_ID_HI6526,           // HiSilicon HI6526
    
    // 直充IC（支持多路）
    POWER_LOG_DEVICE_ID_BQ25970,          // TI BQ25970 (2:1)
    POWER_LOG_DEVICE_ID_BQ25970_1,        // 第2路
    POWER_LOG_DEVICE_ID_BQ25970_2,        // 第3路
    POWER_LOG_DEVICE_ID_RT9759,           // Richtek RT9759 (4:1)
    POWER_LOG_DEVICE_ID_SC8545,           // Southchip SC8545 (2:1)
    
    POWER_LOG_DEVICE_ID_END,              // 总计70+设备类型
};
```

---

## 4. 核心功能实现

### 4.1 设备注册流程
```c
int power_log_ops_register(struct power_log_ops *ops)
{
    struct power_log_dev *l_dev = g_power_log_dev;
    int dev_id;

    // 1. 参数校验
    if (!l_dev || !ops || !ops->dev_name) {
        hwlog_err("l_dev or ops is null\n");
        return -EINVAL;
    }

    // 2. 根据设备名查找对应的设备ID
    dev_id = power_log_get_device_id(ops->dev_name);
    if (dev_id < 0) {
        hwlog_err("%s ops register fail\n", ops->dev_name);
        return -EINVAL;
    }

    // 3. 注册到操作函数数组
    l_dev->ops[dev_id] = ops;
    l_dev->total_ops++;

    hwlog_info("total_ops=%d %d:%s ops register ok\n",
        l_dev->total_ops, dev_id, ops->dev_name);
    return 0;
}
```

**调用时机**：各设备驱动的probe函数中调用

### 4.2 单设备日志输出
```c
// 步骤1: 用户写入设备名
echo "bq25970" > /sys/class/hw_power/power_log/dev_id
    ↓
power_log_set_dev_id()
    ↓ 字符串匹配
power_log_get_device_id("bq25970")
    ↓ 查表得到dev_id=22
mutex_lock(&l_dev->devid_lock);
l_dev->dev_id = 22;  // 设置当前选中设备
mutex_unlock(&l_dev->devid_lock);

// 步骤2: 读取表头
cat /sys/class/hw_power/power_log/head
    ↓
power_log_get_ops(l_dev)  // 根据dev_id=22获取ops
    ↓
ops->dump_log_head(buf, PAGE_SIZE-1, ops->dev_data)
    ↓ 设备驱动实现
scnprintf(buf, size, "VBUS(mV) VBAT(mV) IBAT(mA) TEMP(°C)\n");

// 步骤3: 读取内容
cat /sys/class/hw_power/power_log/content
    ↓
ops->dump_log_content(buf, PAGE_SIZE-1, ops->dev_data)
    ↓ 设备驱动读取寄存器
scnprintf(buf, size, "5000 4200 1500 35\n");
```

### 4.3 全设备日志合并
```c
static int power_log_common_operate(int type, char *buf, int size)
{
    int i, ret;
    int used = 0;
    
    mutex_lock(&l_dev->log_lock);  // 保护日志缓冲区
    
    // 遍历所有已注册设备
    for (i = 0; i < POWER_LOG_DEVICE_ID_END; i++) {
        if (!l_dev->ops[i])
            continue;  // 跳过未注册设备

        // 调用设备回调，输出到临时缓冲区
        ret = power_log_operate_ops(l_dev->ops[i], type,
            l_dev->log_buf, POWER_LOG_MAX_SIZE - 1);
        
        if (ret == POWER_LOG_INVAID_OP)
            continue;  // 设备未实现该操作，跳过
        if (ret)
            break;     // 其他错误，停止输出

        // 将临时缓冲区内容追加到最终输出
        unused = size - POWER_LOG_RESERVED_SIZE - used;
        buf_size = strlen(l_dev->log_buf);
        if (unused > buf_size) {
            strncat(buf, l_dev->log_buf, buf_size);
            used += buf_size;
        } else {
            strncat(buf, l_dev->log_buf, unused);
            used += unused;
            break;  // 输出缓冲区已满
        }
    }
    
    strncat(buf, "\n\0", strlen("\n\0"));
    mutex_unlock(&l_dev->log_lock);
    return used + strlen("\n\0");
}
```

**使用场景**：
```bash
# 一次性输出所有设备的表头
cat /sys/class/hw_power/power_log/head_all

# 一次性输出所有设备的内容
cat /sys/class/hw_power/power_log/content_all
```

---

## 5. Sysfs接口说明

### 5.1 接口列表
| 节点路径 | 权限 | 类型 | 功能说明 |
|---------|------|------|----------|
| `/sys/class/hw_power/power_log/dev_id` | 0660 | RW | 设置/查询当前设备ID |
| `/sys/class/hw_power/power_log/head` | 0440 | RO | 输出当前设备的日志表头 |
| `/sys/class/hw_power/power_log/head_all` | 0440 | RO | 输出所有设备的日志表头 |
| `/sys/class/hw_power/power_log/content` | 0440 | RO | 输出当前设备的日志内容 |
| `/sys/class/hw_power/power_log/content_all` | 0440 | RO | 输出所有设备的日志内容 |

### 5.2 dev_id节点特殊行为
**读取操作**：列出所有已注册设备名
```bash
# cat /sys/class/hw_power/power_log/dev_id
bq25970
bq25970_1
rt9759
cw2217
hi6526
...
```

**写入操作**：切换当前查询的设备
```bash
echo "rt9759" > /sys/class/hw_power/power_log/dev_id
```

---

## 6. 典型使用场景

### 6.1 场景1：查看直充IC工作状态
```bash
# 选择第1路直充IC
echo "bq25970" > /sys/class/hw_power/power_log/dev_id

# 查看字段说明
cat /sys/class/hw_power/power_log/head
# 输出示例：
# VBUS VOUT VBAT IBUS IBAT VUSB IACADP TDIE REG[0x06]...

# 查看实际数据
cat /sys/class/hw_power/power_log/content
# 输出示例：
# 10000 4900 4200 3000 6000 5000 2000 45 0x12...
```

### 6.2 场景2：批量导出所有设备状态
```bash
# 工厂测试脚本
cat /sys/class/hw_power/power_log/head_all > /data/power_log_head.txt
cat /sys/class/hw_power/power_log/content_all > /data/power_log_content.txt

# 输出会包含所有已注册设备的信息
# [bq25970] VBUS VOUT VBAT...
# [rt9759] VIN VOUT IIN...
# [cw2217] Voltage Capacity...
```

### 6.3 场景3：设备驱动注册日志回调
```c
// 在直充IC驱动中
static int bq25970_dump_log_head(char *buf, int size, void *dev_data)
{
    return scnprintf(buf, size,
        "VBUS(mV) VOUT(mV) VBAT(mV) IBUS(mA) IBAT(mA) "
        "TDIE(°C) ALM_FLAG FLT_FLAG\n");
}

static int bq25970_dump_log_content(char *buf, int size, void *dev_data)
{
    struct bq25970_device_info *di = dev_data;
    int vbus, vout, vbat, ibus, ibat, temp;
    u8 alm_flag, flt_flag;

    // 读取寄存器
    bq25970_get_vbus(&vbus, di);
    bq25970_get_vout(&vout, di);
    bq25970_get_vbat(&vbat, di);
    bq25970_get_ibus(&ibus, di);
    bq25970_get_ibat(&ibat, di);
    bq25970_get_temp(&temp, di);
    bq25970_read_byte(BQ25970_ALM_FLAG_REG, &alm_flag, di);
    bq25970_read_byte(BQ25970_FLT_FLAG_REG, &flt_flag, di);

    return scnprintf(buf, size, "%d %d %d %d %d %d 0x%02x 0x%02x\n",
        vbus, vout, vbat, ibus, ibat, temp, alm_flag, flt_flag);
}

static struct power_log_ops bq25970_log_ops = {
    .dev_name = "bq25970",
    .dev_data = NULL,  // 在probe中赋值为di
    .dump_log_head = bq25970_dump_log_head,
    .dump_log_content = bq25970_dump_log_content,
};

static int bq25970_probe(struct i2c_client *client)
{
    struct bq25970_device_info *di;
    // ...设备初始化...

    bq25970_log_ops.dev_data = di;
    power_log_ops_register(&bq25970_log_ops);  // 注册日志回调
    return 0;
}
```

---

## 7. 调试方法

### 7.1 检查设备注册状态
```bash
# 方法1: 查看内核日志
dmesg | grep "power_log"
# 期望输出：
# [   10.123] power_log: total_ops=1 22:bq25970 ops register ok
# [   10.234] power_log: total_ops=2 23:bq25970_1 ops register ok
# [   10.345] power_log: total_ops=3 26:rt9759 ops register ok

# 方法2: 读取dev_id节点
cat /sys/class/hw_power/power_log/dev_id
# 列出所有已注册设备
```

### 7.2 调试单个设备输出
```bash
# 1. 选择设备
echo "bq25970" > /sys/class/hw_power/power_log/dev_id

# 2. 如果写入失败，检查错误日志
dmesg | tail
# 可能输出：
# "bq25970 ops register fail"  --> 设备名不在预定义表中
# "ops is null, dev_id=22"     --> 设备未注册或已注销

# 3. 如果读取无输出，检查回调实现
cat /sys/class/hw_power/power_log/head
# 无输出 --> dump_log_head未实现或返回错误
```

### 7.3 调试全设备输出问题
```bash
# 如果某个设备导致全设备输出中断
cat /sys/class/hw_power/power_log/content_all

# 查看哪个设备报错
dmesg | grep "power_log"
# 输出示例：
# power_log: error type=1, i=25, ret=-5
#            ↑ type=DUMP_LOG_CONTENT
#                     ↑ i=25对应POWER_LOG_DEVICE_ID_RT9759
#                              ↑ ret=-5表示I2C通信失败
```

### 7.4 常见错误排查

| 错误现象 | 可能原因 | 排查方法 |
|---------|---------|---------|
| `echo "xxx" > dev_id` 失败 | 设备名拼写错误或未注册 | 检查g_power_log_device_id_table定义 |
| `cat head` 无输出 | dump_log_head未实现 | 检查设备驱动ops初始化 |
| `cat content` 显示旧数据 | 设备读取失败但未返回错误码 | 在dump_log_content中增加错误处理 |
| 全设备输出只显示前几个 | 某设备输出过长或返回错误 | 使用dmesg查看错误类型和设备ID |
| `total_ops` 计数与预期不符 | 部分设备驱动未调用注册函数 | 检查各驱动probe函数 |

---

## 8. 与其他模块的交互

### 8.1 依赖关系
```
power_log 模块依赖：
├── power_sysfs.h    --> 提供sysfs节点创建辅助函数
├── power_printk.h   --> 提供统一的日志打印宏（hwlog_info/err）
└── 无外部功能依赖   --> 纯日志收集框架，不调用其他电源模块
```

### 8.2 被依赖关系
**所有电源设备驱动**都可能依赖power_log：
- **电量计驱动**（rt9426/cw2217/sh366101）：输出电压/电流/容量/温度
- **普通充电IC**（bq25892/hi6526）：输出充电状态/输入电压/充电电流
- **直充IC**（bq25970/rt9759/sc8545）：输出转换效率/温度/告警标志
- **电池管理**（series_batt）：输出串联电池的单体电压/均衡状态

### 8.3 与power_dsm的配合
**典型场景**：当power_log发现异常数据时触发DSM上报
```c
// 在设备驱动的dump_log_content实现中
static int bq25970_dump_log_content(char *buf, int size, void *dev_data)
{
    struct bq25970_device_info *di = dev_data;
    int vbus, ibat;
    u8 flt_flag;

    bq25970_get_vbus(&vbus, di);
    bq25970_get_ibat(&ibat, di);
    bq25970_read_byte(BQ25970_FLT_FLAG_REG, &flt_flag, di);

    // 异常检测
    if (flt_flag & BQ25970_VBAT_OVP_FLT) {
        power_dsm_report_dmd(POWER_DSM_DIRECT_CHARGE_SC,
            ERROR_VBAT_OVP, "VBAT OVP: vbus=%d ibat=%d\n", vbus, ibat);
    }

    return scnprintf(buf, size, "%d %d 0x%02x\n", vbus, ibat, flt_flag);
}
```

---

## 9. 关键设计细节

### 9.1 为何需要两级日志（head/content）
**设计原因**：
1. **可读性**：表头提供字段说明，避免裸数据难以理解
2. **灵活性**：内容格式可随硬件版本变化，表头同步更新说明
3. **自动化**：脚本可先解析head确定字段顺序，再解析content提取数据

**实际案例**：
```bash
# 不同版本IC的寄存器可能不同
# V1.0版本
head:   "VBUS VBAT IBUS IBAT TEMP"
content: "10000 4200 3000 6000 45"

# V2.0版本增加了电源路径检测
head:   "VBUS VBAT IBUS IBAT TEMP VUSB PP_FLAG"
content: "10000 4200 3000 6000 45 5000 0x01"
```

### 9.2 为何使用4KB临时缓冲区
**设计考量**：
1. **避免溢出**：sysfs的PAGE_SIZE限制（通常4KB），直接写入可能越界
2. **原子性**：先在临时缓冲区构造完整日志，最后一次性拷贝到输出
3. **安全性**：每次操作前memset清零，避免遗留旧数据泄露

### 9.3 为何支持多路直充IC
**硬件背景**：
- MATE X5支持**100W+超级快充**，单颗直充IC功率不足
- 采用**3路并联直充方案**：每路33W，总计100W
- 每路IC需要独立监控，故预留了`_1`、`_2`、`_3`后缀

**实现方式**：
```c
// 设备ID定义
POWER_LOG_DEVICE_ID_BQ25970,    // 主路
POWER_LOG_DEVICE_ID_BQ25970_1,  // 第2路
POWER_LOG_DEVICE_ID_BQ25970_2,  // 第3路

// 驱动注册
static struct power_log_ops bq25970_aux_log_ops = {
    .dev_name = "bq25970_1",  // 与主路ops独立
    .dev_data = di_aux,
    ...
};
```

---

## 10. 最佳实践建议

### 10.1 设备驱动开发者
1. **必须实现两个回调**：dump_log_head和dump_log_content
2. **表头格式规范**：字段名使用单位后缀（如"VBUS(mV)"）
3. **错误处理**：I2C读取失败时返回负数错误码，而非输出错误数据
4. **性能考虑**：避免在回调中执行耗时操作（如等待ADC转换完成）

### 10.2 系统集成者
1. **检查注册完整性**：确保所有关键设备都成功注册
   ```bash
   dmesg | grep "ops register ok" | wc -l  # 统计注册设备数
   ```
2. **定期导出日志**：建议每小时保存一次全设备状态
   ```bash
   # crontab任务
   0 * * * * cat /sys/.../content_all > /data/log/power_$(date +\%H).log
   ```

### 10.3 调试工程师
1. **快速定位异常设备**：
   ```bash
   # 遍历所有设备，找出无输出的
   for dev in $(cat /sys/.../dev_id); do
       echo "$dev" > /sys/.../dev_id
       output=$(cat /sys/.../content 2>&1)
       [ -z "$output" ] && echo "ERROR: $dev no output"
   done
   ```

2. **对比前后状态**：
   ```bash
   # 操作前
   cat /sys/.../content_all > before.log
   # 执行充电操作
   # 操作后
   cat /sys/.../content_all > after.log
   diff before.log after.log
   ```

---

## 11. 总结

### 11.1 核心特性
| 特性 | 说明 |
|-----|------|
| **设备覆盖** | 支持70+种电源设备（电量计/充电IC/直充IC等） |
| **输出模式** | 单设备精准查询 + 全设备批量导出 |
| **日志分级** | 表头（字段说明） + 内容（实际数据） |
| **多路支持** | 同型号芯片支持3路并联实例 |
| **并发保护** | 双mutex分别保护设备切换和日志缓冲区 |

### 11.2 价值体现
1. **统一接口**：各设备驱动无需自行实现sysfs节点
2. **灵活扩展**：新增设备只需注册ops即可，无需修改框架代码
3. **调试便捷**：通过adb shell即可实时查看所有电源设备状态
4. **工具友好**：结构化输出便于自动化脚本解析和分析