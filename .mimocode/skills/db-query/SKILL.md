---
name: db-query
description: 编写和执行SQL查询，分析数据库结果；触发词：数据库查询、SQL查询、执行SQL、/db-query
version: 1.0.0
---
# DB Query — 数据库查询技能

## Purpose

理解查询需求，编写优化的SQL语句，执行查询并分析结果，提供性能优化建议。

## Step 1：确认查询需求

用 AskUserQuestion 询问：

1. **数据库类型**：MySQL、PostgreSQL、SQLite、MongoDB等
2. **连接信息**：主机、端口、数据库名、用户（敏感信息不记录）
3. **查询目标**：数据检索、数据修改、统计分析、性能优化
4. **输出格式**：表格、JSON、CSV、图表

## Step 2：分析表结构

### 获取表信息
```sql
-- MySQL
SHOW TABLES;
DESCRIBE <表名>;
SHOW CREATE TABLE <表名>;

-- PostgreSQL
\dt
\d <表名>

-- SQLite
.tables
.schema <表名>
```

### 分析表关系
```sql
-- 检查外键约束
SELECT 
    TABLE_NAME,
    COLUMN_NAME,
    REFERENCED_TABLE_NAME,
    REFERENCED_COLUMN_NAME
FROM INFORMATION_SCHEMA.KEY_COLUMN_USAGE
WHERE REFERENCED_TABLE_NAME IS NOT NULL;

-- 检查索引
SHOW INDEX FROM <表名>;
```

## Step 3：编写SQL语句

### 查询优化原则
1. **使用索引**：确保WHERE、JOIN、ORDER BY字段有索引
2. **避免SELECT ***：只选择需要的列
3. **使用LIMIT**：限制返回结果数量
4. **避免子查询**：使用JOIN替代
5. **使用EXPLAIN**：分析查询执行计划

### 常用查询模式
```sql
-- 分页查询
SELECT * FROM <表名> 
WHERE id > <最后ID>
ORDER BY id 
LIMIT <页面大小>;

-- 聚合查询
SELECT 
    <分组字段>,
    COUNT(*) as count,
    SUM(<字段>) as total,
    AVG(<字段>) as average
FROM <表名>
GROUP BY <分组字段>
HAVING COUNT(*) > <阈值>;

-- 连接查询
SELECT 
    a.<字段>,
    b.<字段>
FROM <表1> a
INNER JOIN <表2> b ON a.id = b.<外键>
WHERE a.<条件>;

-- 子查询优化为JOIN
-- 优化前
SELECT * FROM <表1> 
WHERE id IN (SELECT id FROM <表2>);

-- 优化后
SELECT a.* FROM <表1> a
INNER JOIN <表2> b ON a.id = b.id;
```

## Step 4：执行查询

### 测试环境执行
```bash
# MySQL
mysql -h <主机> -P <端口> -u <用户> -p<密码> <数据库名> -e "<SQL语句>"

# PostgreSQL
psql -h <主机> -p <端口> -U <用户> -d <数据库名> -c "<SQL语句>"

# SQLite
sqlite3 <数据库文件> "<SQL语句>"
```

### 分析执行计划
```sql
-- MySQL
EXPLAIN ANALYZE <SQL语句>;

-- PostgreSQL
EXPLAIN (ANALYZE, BUFFERS) <SQL语句>;

-- SQLite
EXPLAIN QUERY PLAN <SQL语句>;
```

## Step 5：分析结果

### 结果统计
```bash
# 统计行数
wc -l <结果文件>

# 统计列数
head -1 <结果文件> | awk -F',' '{print NF}'

# 计算聚合值
awk -F',' '{sum+=$1} END {print "Total:", sum}' <结果文件>
```

### 数据质量检查
```sql
-- 检查空值
SELECT COUNT(*) FROM <表名> WHERE <字段> IS NULL;

-- 检查重复值
SELECT <字段>, COUNT(*) 
FROM <表名> 
GROUP BY <字段> 
HAVING COUNT(*) > 1;

-- 检查数据范围
SELECT MIN(<字段>), MAX(<字段>), AVG(<字段>)
FROM <表名>;
```

## Step 6：生成查询报告

### 报告格式
```
🗄️ 数据库查询报告
================

📋 查询信息
- 数据库: <数据库名>
- 表: <表名>
- 查询类型: <SELECT/INSERT/UPDATE/DELETE>
- 执行时间: <时间>

📊 查询结果
- 返回行数: <数量>
- 影响行数: <数量>
- 执行状态: <成功/失败>

🔍 执行计划
- 扫描类型: <全表扫描/索引扫描>
- 预估行数: <数量>
- 实际行数: <数量>
- 执行成本: <成本>

📈 性能分析
- 查询时间: <时间>
- 内存使用: <大小>
- 临时表: <是/否>
- 文件排序: <是/否>

⚠️  优化建议
1. <建议1>
2. <建议2>
3. <建议3>

📁 索引建议
- 建议索引: CREATE INDEX <索引名> ON <表名>(<字段>);
- 索引类型: <B-tree/Hash/GiST>
- 预期提升: <百分比>%

🔧 查询优化
-- 优化前
<原始SQL>

-- 优化后
<优化SQL>
```

## 注意事项

- 生产环境查询前先在测试环境验证
- 大数据量查询使用分页和LIMIT
- 敏感数据查询注意权限控制
- 保存查询历史和执行计划
- 定期分析慢查询日志
- 对于复杂查询，添加注释说明逻辑