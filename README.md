# 双色球中奖查询 Web 应用

拍照上传双色球彩票，视觉大模型自动识别投注号码与期号，从中彩网实时拉取开奖数据进行逐注比对。

## 功能特性

- **拍照识别**：手机端调用摄像头拍照，PC 端拖拽或点击上传，视觉大模型自动提取号码
- **自动比对**：识别期号后自动从中彩网 API 获取开奖号码，逐注计算中奖等级
- **响应式设计**：PC 端卡片居中布局，移动端全屏适配，支持深色模式
- **离线降级**：中彩网不可达时清晰提示原因，识别结果正常展示

## 快速开始

### 1. 安装依赖

```bash
pip install -r requirements.txt
```

### 2. 配置 API 密钥

编辑 `config.json`，填入视觉模型 API 密钥：

```json
{
  "api_key": "sk-your-api-key",
  "base_url": "https://dashscope.aliyuncs.com/compatible-mode/v1",
  "model": "qwen-vl-max"
}
```

支持任意 OpenAI 兼容接口（通义千问、DeepSeek、GPT-4o 等）。

### 3. 启动

```bash
python app.py
```

访问 http://127.0.0.1:5000

## API 接口

| 方法 | 路径 | 说明 |
|------|------|------|
| `POST` | `/api/check` | 上传彩票照片（multipart/form-data, file 字段），返回识别 + 比对结果 |
| `GET` | `/api/health` | 健康检查 |

### POST /api/check 响应示例

**成功比对：**

```json
{
  "success": true,
  "has_winning_numbers": true,
  "period": "2026061",
  "entries": [
    {"label": "A", "reds": [1,2,3,4,5,6], "blue": 7, "reds_display": ["01","02",...], "blue_display": "07"}
  ],
  "total": 1,
  "cost": 2,
  "winning": {"reds": [1,3,5,7,9,11], "blue": 7, "reds_display": [...], "blue_display": "07"},
  "results": [
    {"label": "A", "level": 6, "desc": "六等奖（蓝球中）", "red_hit": 2, "blue_hit": true}
  ],
  "stats": {"1": 0, "2": 0, "3": 0, "4": 0, "5": 0, "6": 1, "0": 0}
}
```

**无法获取开奖号码：**

```json
{
  "success": true,
  "has_winning_numbers": false,
  "fetch_error": "期号 2026061 暂无开奖数据（可能尚未开奖或期号不存在）",
  "period": "2026061",
  "entries": [...],
  "total": 1,
  "cost": 2
}
```

## 技术栈

- **后端**：Flask + flask-cors
- **视觉识别**：OpenAI 兼容视觉 API（qwen-vl-max / GPT-4o 等）
- **开奖数据**：中国福利彩票官网 API（cwl.gov.cn）
- **前端**：原生 HTML/CSS/JS，HTML5 MediaDevices API（摄像头）

## 项目结构

```
ssq_web/
├── app.py              # Flask 后端（内联视觉识别 + 中彩网抓取 + 中奖比对）
├── config.json         # API 配置
├── requirements.txt    # Python 依赖
├── static/
│   ├── style.css       # 响应式样式（红蓝主题 + 深色模式）
│   └── script.js       # 前端交互（上传 / 拍照 / 结果渲染）
├── templates/
│   └── index.html      # 主页面
└── README.md
```