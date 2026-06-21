---
name: code-commit
description: 分析代码变更并生成详细的commit信息，执行git提交；触发词：提交代码、git commit、代码提交、/code-commit
version: 1.0.0
---
# Code Commit — 代码提交技能

## Purpose

分析代码变更，生成符合 conventional commits 规范的详细commit信息，并执行git提交。

## Step 1：确认提交范围

用 AskUserQuestion 询问：

1. **提交类型**：feat（新功能）、fix（修复）、chore（维护）、docs（文档）、style（样式）、refactor（重构）、test（测试）、perf（性能）
2. **提交范围**：全部变更、指定文件、指定目录
3. **是否包含测试**：是否提交测试文件
4. **是否包含文档**：是否提交文档更新

## Step 2：分析代码变更

### 变更概览
```bash
git status
git diff --stat
git diff --cached --stat
```

### 详细变更
```bash
git diff
git diff --cached
```

### 变更文件分类
```bash
# 新增文件
git status --porcelain | grep "^A"

# 修改文件
git status --porcelain | grep "^M"

# 删除文件
git status --porcelain | grep "^D"

# 重命名文件
git status --porcelain | grep "^R"
```

## Step 3：生成Commit信息

### 信息结构
```
<type>(<scope>): <subject>

<body>

<footer>
```

### Subject 规则
- 使用中文描述
- 不超过50个字符
- 使用祈使语气
- 首字母小写
- 不加句号

### Body 规则
- 详细描述变更内容
- 解释为什么做这个变更
- 列出主要改动点
- 每行不超过72个字符

### Footer 规则
- 关联Issue：`Closes #123`
- 破坏性变更：`BREAKING CHANGE: <描述>`
- 版本号：`Release: v1.0.0`

## Step 4：执行提交

### 暂存文件
```bash
# 全部暂存
git add .

# 指定文件暂存
git add <文件1> <文件2>

# 指定目录暂存
git add <目录>/
```

### 执行提交
```bash
git commit -m "<type>(<scope>): <subject>

<body>

<footer>"
```

### 验证提交
```bash
git log -1
git status
```

## Step 5：输出结果

### 提交摘要
```
✅ 代码提交成功

📋 提交信息
<type>(<scope>): <subject>

📝 变更详情
- 新增文件: <数量>
- 修改文件: <数量>
- 删除文件: <数量>
- 重命名文件: <数量>

📁 主要变更文件
1. <文件1>: <变更说明>
2. <文件2>: <变更说明>
3. <文件3>: <变更说明>

🔗 关联Issue
<Issue链接>

🚀 后续操作
- 推送远程: git push
- 创建PR: gh pr create
```

## 注意事项

- 遵循 conventional commits 规范
- 使用中文描述，符合项目提交历史风格
- 不提交敏感信息（.env、credentials.json等）
- 提交前检查是否有未保存的更改
- 对于大型变更，考虑拆分为多个提交
- 验证提交信息格式和内容