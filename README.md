# 超星学习通自动化完成任务点(Web UI版)

一个基于 Flask Web UI 和本地 API 适配层的超星学习辅助工具，提供课程管理、任务队列、执行进度、运行记录、题库配置和多用户会话管理。

## 功能特性

- 仅支持超星账号密码登录。
- 首页同步课程并展示课程、章节和待处理任务概览。
- 课程管理：查看课程、章节和任务点，将整门课程或单个任务加入执行队列。
- 执行中心：支持启动、暂停、继续和停止任务，显示任务及视频播放进度。
- 运行记录：记录登录、课程同步、章节读取和任务执行结果，支持单条删除和全部删除。
- 系统设置：配置学习速度、重试策略、题库、GO 题、LIKE 知识库、模型和通知参数。
- SQLite 持久化：系统设置和运行记录保存到本地数据库，应用重启后仍然保留。
- 多用户数据隔离：不同账号的设置、运行记录、活动和任务状态互不混用。
- 同账号单点登录：同一账号在新设备登录后，旧设备会被强制下线，并提示新设备登录时间。


## 源码运行（Python 3.13+）

### Windows

```bash
git clone https://github.com/ThekingMX1998/chaoxing
cd chaoxing

pip install -r requirements.txt
python main.py
```

### Linux / macOS

```bash
git clone https://github.com/ThekingMX1998/chaoxing
cd chaoxing

python3 -m venv .venv
source .venv/bin/activate
pip install -r requirements.txt
python main.py
```

启动后访问：

```text
http://127.0.0.1:5000
```

开发入口位于 `main.py`，默认监听 `127.0.0.1:5000`。


## 免责声明
- 本代码遵循 [GPL-3.0 License](https://github.com/Samueli924/chaoxing/blob/main/LICENSE) 协议，允许**开源/免费使用和引用/修改/衍生代码的开源/免费使用**，不允许**修改和衍生的代码作为闭源的商业软件发布和销售**，禁止**使用本代码盈利**，以此代码为基础的程序**必须**同样遵守 [GPL-3.0 License](https://github.com/Samueli924/chaoxing/blob/main/LICENSE) 协议
- 本代码仅用于**学习讨论**，禁止**用于盈利**
- 他人或组织使用本代码进行的任何**违法行为**与本人无关