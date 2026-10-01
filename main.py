"""超星学习通 Web UI 启动入口。

前端页面和本地 API 适配逻辑位于 web/ 目录，根目录保留一个简单入口，
方便直接使用 `python main.py` 启动本地控制台。
"""

from web.app import app


if __name__ == "__main__":
    app.run(host="127.0.0.1", port=5000, debug=True)
