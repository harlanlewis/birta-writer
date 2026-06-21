---
name: test-runner
description: 运行测试并分析结果，提供详细的测试报告；触发词：运行测试、测试运行、执行测试、/test-runner
version: 1.0.0
---
# Test Runner — 测试运行技能

## Purpose

运行项目测试，分析测试结果，提供详细的测试报告和改进建议。

## Step 1：确认测试范围

用 AskUserQuestion 询问：

1. **测试类型**：单元测试、集成测试、端到端测试、所有测试
2. **测试范围**：全部测试、指定文件、指定方法
3. **测试框架**：Jest、Vitest、Mocha、Pytest等（自动检测）
4. **覆盖率要求**：是否生成覆盖率报告

## Step 2：检测测试环境

### 检测测试框架
```bash
# Node.js项目
ls package.json
cat package.json | grep -E "(jest|vitest|mocha|jasmine)"

# Python项目
ls requirements.txt setup.py pyproject.toml
cat requirements.txt | grep -E "(pytest|unittest|nose)"

# Java项目
ls pom.xml build.gradle
cat pom.xml | grep -E "(junit|testng)"
```

### 检测测试文件
```bash
# 查找测试文件
find . -name "*.test.*" -o -name "*.spec.*" -o -name "*_test.*" -o -name "test_*"

# 查找测试目录
find . -type d -name "test" -o -name "tests" -o -name "__tests__"
```

## Step 3：运行测试

### 运行所有测试
```bash
# Node.js
npm test
# 或
yarn test
# 或
pnpm test

# Python
pytest
# 或
python -m unittest discover

# Java
mvn test
# 或
gradle test
```

### 运行指定测试
```bash
# Node.js
npm test -- --testPathPattern=<模式>
npm test -- --testNamePattern=<名称>

# Python
pytest <文件路径>::<测试方法>
python -m unittest <测试类>.<测试方法>

# Java
mvn test -Dtest=<测试类>#<测试方法>
```

### 生成覆盖率报告
```bash
# Node.js
npm test -- --coverage
npx jest --coverage

# Python
pytest --cov=<模块>
coverage run -m pytest
coverage report

# Java
mvn test jacoco:report
```

## Step 4：分析测试结果

### 结果统计
```bash
# 统计测试结果
grep -c "PASS" <测试输出>
grep -c "FAIL" <测试输出>
grep -c "SKIP" <测试输出>

# 计算通过率
echo "scale=2; $PASS * 100 / ($PASS + $FAIL + $SKIP)" | bc
```

### 失败详情
```bash
# 提取失败测试
grep -A 10 "FAIL" <测试输出>

# 提取错误信息
grep -B 5 -A 10 "Error\|Exception" <测试输出>
```

### 性能分析
```bash
# 提取执行时间
grep -o "Time: [0-9.]*" <测试输出> | tail -5

# 统计总执行时间
grep "Time:" <测试输出> | tail -1
```

## Step 5：生成测试报告

### 报告格式
```
🧪 测试执行报告
================

📊 测试概览
- 测试框架: <框架名称>
- 测试文件: <数量>
- 测试方法: <数量>
- 执行时间: <时间>

📈 测试结果
- 通过: <数量> (<百分比>%)
- 失败: <数量> (<百分比>%)
- 跳过: <数量> (<百分比>%)
- 错误: <数量> (<百分比>%)

✅ 通过的测试
1. <测试1>
2. <测试2>

❌ 失败的测试
1. <测试1>: <失败原因>
2. <测试2>: <失败原因>

⚠️  跳过的测试
1. <测试1>: <跳过原因>

🔧 改进建议
1. <建议1>
2. <建议2>
3. <建议3>

📁 覆盖率报告
- 行覆盖率: <百分比>%
- 函数覆盖率: <百分比>%
- 分支覆盖率: <百分比>%
```

## 注意事项

- 确保测试环境正确配置
- 测试前清理临时文件和状态
- 对于数据库测试，使用事务回滚
- 记录测试环境信息（操作系统、版本等）
- 保存测试报告供后续分析
- 对于性能测试，多次运行取平均值