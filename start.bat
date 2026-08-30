@echo off
chcp 65001 >nul
title 智绘 AI - Diagram Studio
cd /d "%~dp0"

rem 首次运行：自动获取 draw.io 引擎源码（约231MB，仅一次）
if not exist "drawio-src\src\main\webapp\index.html" (
  echo [首次运行] 正在获取 draw.io 引擎源码，约 231MB，请耐心等待...
  git clone --depth 1 https://github.com/jgraph/drawio.git drawio-src
  if not exist "drawio-src\src\main\webapp\index.html" (
    echo [错误] draw.io 源码获取失败，请检查网络（或手动执行 git clone --depth 1 https://github.com/jgraph/drawio.git drawio-src）后重试
    pause
    exit /b 1
  )
)

rem 首次运行：从模板创建 .env 并要求填写 API Key
if not exist ".env" (
  echo [首次运行] 未找到 .env，已从模板创建，请在打开的记事本中填入你的 DeepSeek API Key 后保存关闭
  copy .env.example .env >nul
  notepad .env
)

echo.
echo   正在启动 智绘 AI · Diagram Studio ...
echo   浏览器访问: http://localhost:3210
echo.
start "" http://localhost:3210
node server.js
pause
