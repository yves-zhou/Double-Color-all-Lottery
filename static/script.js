/**
 * 双色球中奖查询 — 前端交互逻辑
 * 支持 PC 拖拽上传、移动端拍照/相册、结果展示
 * 新增：图片压缩、SSE 进度推送、两步拆分流程
 */

(function () {
  'use strict';

  // ── DOM 引用 ──────────────────────────────────────────
  const $ = (s) => document.querySelector(s);
  const $$ = (s) => document.querySelectorAll(s);

  const uploadSection = $('#uploadSection');
  const uploadCard = $('#uploadCard');
  const uploadArea = $('#uploadArea');
  const fileInput = $('#fileInput');
  const mobileButtons = $('#mobileButtons');

  const previewArea = $('#previewArea');
  const previewImage = $('#previewImage');
  const btnConfirm = $('#btnConfirm');
  const btnRetake = $('#btnRetake');

  const loadingEl = $('#loading');
  const progressPanel = $('#progressPanel');
  const progressMessage = $('#progressMessage');
  const step1 = $('#step1');
  const step2 = $('#step2');
  const step3 = $('#step3');
  const errorBox = $('#errorBox');
  const errorMessage = $('#errorMessage');
  const resultsEl = $('#results');

  // Camera
  const cameraOverlay = $('#cameraOverlay');
  const cameraVideo = $('#cameraVideo');
  const cameraCanvas = $('#cameraCanvas');
  const btnCamera = $('#btnCamera');
  const btnGallery = $('#btnGallery');
  const btnCapture = $('#btnCapture');
  const btnCloseCamera = $('#btnCloseCamera');
  const btnSwitchCamera = $('#btnSwitchCamera');

  let currentFile = null;       // 待上传的 File
  let cameraStream = null;      // 摄像头 MediaStream
  let facingMode = 'environment'; // 后置摄像头
  let recognizedData = null;    // SSE 识别结果 { period, entries }

  // ── 工具函数 ──────────────────────────────────────────
  function show(el) { el.classList.remove('hidden'); }
  function hide(el) { el.classList.add('hidden'); }

  function setLoading(active) {
    active ? show(loadingEl) : hide(loadingEl);
    if (active) { hide(errorBox); hide(resultsEl); }
  }

  function showError(msg) {
    hide(loadingEl);
    hide(progressPanel);
    hide(resultsEl);
    errorMessage.textContent = msg;
    show(errorBox);
  }

  function resetUploadUI() {
    hide(previewArea);
    show(uploadCard);
    currentFile = null;
    recognizedData = null;
    fileInput.value = '';
    hide(errorBox);
    hide(resultsEl);
    hide(progressPanel);
  }

  function resetProgress() {
    [step1, step2, step3].forEach(s => s.classList.remove('active'));
    progressMessage.textContent = '准备中...';
  }

  function setStepActive(num, msg) {
    resetProgress();
    for (let i = 1; i <= num; i++) {
      const step = document.getElementById('step' + i);
      if (step) step.classList.add('active');
    }
    progressMessage.textContent = msg;
  }

  // ── 图片压缩 ──────────────────────────────────────────
  function compressImage(file) {
    return new Promise((resolve, reject) => {
      if (!file.type.startsWith('image/')) {
        return resolve(file);
      }
      const img = new Image();
      const url = URL.createObjectURL(file);
      img.onload = () => {
        URL.revokeObjectURL(url);
        let w = img.width;
        let h = img.height;
        const maxSide = 1024;
        if (w <= maxSide && h <= maxSide) {
          return resolve(file);
        }
        if (w > h) { h = Math.round(h * maxSide / w); w = maxSide; }
        else       { w = Math.round(w * maxSide / h); h = maxSide; }

        const canvas = document.createElement('canvas');
        canvas.width = w;
        canvas.height = h;
        const ctx = canvas.getContext('2d');
        ctx.drawImage(img, 0, 0, w, h);
        canvas.toBlob((blob) => {
          if (!blob) { return resolve(file); }
          const compressed = new File([blob], file.name, { type: 'image/jpeg' });
          resolve(compressed);
        }, 'image/jpeg', 0.75);
      };
      img.onerror = () => { URL.revokeObjectURL(url); resolve(file); };
      img.src = url;
    });
  }

  // ── 文件选择处理 ──────────────────────────────────────
  async function handleFile(file) {
    if (!file || !file.type.startsWith('image/')) {
      showError('请选择图片文件（JPG / PNG / HEIC）');
      return;
    }
    currentFile = await compressImage(file);
    const url = URL.createObjectURL(currentFile);
    previewImage.src = url;
    hide(uploadCard);
    show(previewArea);
    hide(errorBox);
    hide(resultsEl);
  }

  // ── 上传区域事件 ──────────────────────────────────────
  uploadArea.addEventListener('click', () => fileInput.click());
  btnGallery.addEventListener('click', (e) => {
    e.stopPropagation();
    fileInput.click();
  });

  fileInput.addEventListener('change', () => {
    if (fileInput.files && fileInput.files[0]) {
      handleFile(fileInput.files[0]);
    }
  });

  // ── 拖拽上传（PC）─────────────────────────────────────
  uploadCard.addEventListener('dragover', (e) => {
    e.preventDefault();
    uploadCard.classList.add('drag-over');
  });
  uploadCard.addEventListener('dragleave', () => {
    uploadCard.classList.remove('drag-over');
  });
  uploadCard.addEventListener('drop', (e) => {
    e.preventDefault();
    uploadCard.classList.remove('drag-over');
    const file = e.dataTransfer.files[0];
    handleFile(file);
  });

  // ── 预览操作 ──────────────────────────────────────────
  btnRetake.addEventListener('click', resetUploadUI);

  // ════════════════════════════════════════════════════════
  //  两步流程：第 1 步 — SSE 识别
  // ════════════════════════════════════════════════════════

  btnConfirm.addEventListener('click', async () => {
    if (!currentFile) return;
    hide(previewArea);
    hide(errorBox);
    hide(resultsEl);
    hide(loadingEl);

    // 显示进度面板
    show(progressPanel);

    const formData = new FormData();
    formData.append('file', currentFile);

    try {
      const resp = await fetch('/api/recognize-sse', {
        method: 'POST',
        body: formData,
      });

      if (!resp.ok) {
        hide(progressPanel);
        showError(`服务器错误：${resp.status}`);
        return;
      }

      const reader = resp.body.getReader();
      const decoder = new TextDecoder();
      let buffer = '';

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });

        // 解析 SSE 事件
        const lines = buffer.split('\n');
        buffer = lines.pop() || ''; // 保留未完成的行
        for (const line of lines) {
          if (line.startsWith('data: ')) {
            try {
              const data = JSON.parse(line.slice(6));
              if (data.event === 'progress') {
                const stageMap = { upload:1, vision:2, parse:3 };
                const num = stageMap[data.stage] || 1;
                setStepActive(num, data.message);
              } else if (data.success) {
                // 识别成功
                recognizedData = { period: data.period, entries: data.entries };
                hide(progressPanel);
                renderRecognized(recognizedData);
                show(resultsEl);
                show(uploadCard);
              } else {
                hide(progressPanel);
                showError(data.error || '识别失败');
              }
            } catch (e) {}
          }
        }
      }
    } catch (err) {
      hide(progressPanel);
      showError(`网络请求失败：${err.message}`);
    }
  });

  // ════════════════════════════════════════════════════════
  //  两步流程：第 2 步 — 中奖查询
  // ════════════════════════════════════════════════════════

  async function checkPrize() {
    if (!recognizedData) return;
    setLoading(true);

    try {
      const resp = await fetch('/api/check', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          period: recognizedData.period,
          entries: recognizedData.entries,
        }),
      });
      const data = await resp.json();
      setLoading(false);

      if (data.success && data.results) {
        renderResults(data);
        show(resultsEl);
        show(uploadCard);
      } else if (data.success && !data.has_winning_numbers) {
        renderPartial(data);
        show(resultsEl);
        show(uploadCard);
      } else {
        showError(data.error || '查询失败');
      }
    } catch (err) {
      setLoading(false);
      showError(`网络请求失败：${err.message}`);
    }
  }

  // ════════════════════════════════════════════════════════
  //  结果渲染
  // ════════════════════════════════════════════════════════

  function renderBalls(reds, blue, sm = false) {
    const cls = sm ? 'ball ball-red ball-sm' : 'ball ball-red';
    const redHTML = reds.map(r => `<span class="${cls}">${String(r).padStart(2, '0')}</span>`).join('');
    const blueCls = sm ? 'ball ball-blue ball-sm' : 'ball ball-blue';
    return `${redHTML} <span class="${blueCls}">${String(blue).padStart(2, '0')}</span>`;
  }

  function renderRecognized(data) {
    const { period, entries } = data;

    let html = '';

    // ── 识别结果卡 ──────────────────────────────────────
    html += `<div class="result-card">
      <div class="result-card-header">
        <span>识别结果${period ? '（第 ' + period + ' 期）' : ''}</span>
      </div>
      <div class="result-card-body">
        <table class="entry-table">
          <thead><tr><th></th><th>投注号码</th></tr></thead>
          <tbody>`;
    entries.forEach((e) => {
      html += `<tr>
        <td style="font-weight:700;width:32px;">${e.label}</td>
        <td>${renderBalls(e.reds, e.blue, true)}</td>
      </tr>`;
    });
    html += `</tbody></table>
        <div style="margin-top:16px;text-align:center;">
          <button class="btn btn-primary" id="btnCheckPrize" style="min-width:160px;">
            查询中奖
          </button>
        </div>
      </div>
    </div>`;

    resultsEl.innerHTML = html;

    // 绑定查询中奖按钮
    const btnCheck = $('#btnCheckPrize');
    if (btnCheck) {
      btnCheck.addEventListener('click', checkPrize);
    }
  }

  function renderResults(data) {
    const { period, entries, total, cost, winning, results, stats } = data;

    let html = '';

    // ── 开奖号码卡 ──────────────────────────────────────
    html += `<div class="result-card">
      <div class="result-card-header">
        <span>第 ${period} 期中奖号码</span>
      </div>
      <div class="result-card-body" style="text-align:center;font-size:0;">
        ${renderBalls(winning.reds_display.map(Number), winning.blue)}
      </div>
    </div>`;

    // ── 逐注比对表 ──────────────────────────────────────
    html += `<div class="result-card">
      <div class="result-card-header">
        <span>投注比对（共 ${total} 注，${cost} 元）</span>
      </div>
      <div class="result-card-body">
        <table class="entry-table">
          <thead>
            <tr>
              <th></th>
              <th>投注号码</th>
              <th>红球命中</th>
              <th>蓝球</th>
              <th>结果</th>
            </tr>
          </thead>
          <tbody>`;

    const prizeNames = {1:'一等奖',2:'二等奖',3:'三等奖',4:'四等奖',5:'五等奖',6:'六等奖',0:'未中奖'};
    const prizeClass = (lv) => lv === 1 ? 'prize-tag jackpot' : lv > 0 ? 'prize-tag won' : 'prize-tag lost';

    results.forEach((r, i) => {
      const rowCls = r.level > 0 ? 'won' : '';
      html += `<tr class="${rowCls}">
        <td style="font-weight:700;width:32px;">${r.label}</td>
        <td>${renderBalls(r.reds, r.blue, true)}</td>
        <td>${r.red_hit}/6</td>
        <td>${r.blue_hit ? '✓' : '✗'}</td>
        <td><span class="${prizeClass(r.level)}">${prizeNames[r.level]}</span></td>
      </tr>`;
    });

    html += `</tbody></table></div></div>`;

    // ── 统计汇总 ────────────────────────────────────────
    html += `<div class="result-card">
      <div class="result-card-header">中奖统计</div>
      <div class="result-card-body">`;

    const hitTotal = total - (stats[0] || 0);
    if (hitTotal > 0) {
      html += `<div class="stats-grid">`;
      for (let lv = 1; lv <= 6; lv++) {
        if (stats[lv] > 0) {
          html += `<div class="stat-item hit">
            <div class="stat-value red">${stats[lv]}</div>
            <div class="stat-label">${prizeNames[lv]}</div>
          </div>`;
        }
      }
      html += `</div>`;
    } else {
      html += `<p style="text-align:center;color:var(--text-secondary);padding:12px;">很遗憾，本次未中奖</p>`;
    }

    html += `<div class="summary-row" style="margin-top:12px;">
      <span style="color:var(--text-secondary);">总注数</span>
      <span style="font-weight:700;">${total} 注 / ${cost} 元</span>
    </div>`;

    html += `</div></div>`;

    resultsEl.innerHTML = html;
  }

  function renderPartial(data) {
    const { period, entries, total, cost, fetch_error } = data;

    let html = '';

    // ── 识别结果卡 ──────────────────────────────────────
    html += `<div class="result-card">
      <div class="result-card-header">
        <span>识别结果${period ? '（第 ' + period + ' 期）' : ''}</span>
      </div>
      <div class="result-card-body">
        <table class="entry-table">
          <thead><tr><th></th><th>投注号码</th></tr></thead>
          <tbody>`;
    entries.forEach((e) => {
      html += `<tr>
        <td style="font-weight:700;width:32px;">${e.label}</td>
        <td>${renderBalls(e.reds, e.blue, true)}</td>
      </tr>`;
    });
    html += `</tbody></table></div></div>`;

    // ── 提示卡 ──────────────────────────────────────────
    html += `<div class="result-card">
      <div class="result-card-header" style="color:var(--red);">
        <span>无法获取中奖号码</span>
      </div>
      <div class="result-card-body">
        <p style="color:var(--text-secondary);">${fetch_error || '未知原因'}</p>
      </div>
    </div>`;

    resultsEl.innerHTML = html;
  }

  // ════════════════════════════════════════════════════════
  //  摄像头模块（移动端）
  // ════════════════════════════════════════════════════════

  btnCamera.addEventListener('click', (e) => {
    e.stopPropagation();
    openCamera();
  });

  async function openCamera() {
    stopCamera();

    // 安全上下文检查：getUserMedia 要求 HTTPS 或 localhost
    if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
      const protocol = location.protocol;
      const hostname = location.hostname;
      if (protocol !== 'https:' && hostname !== 'localhost' && hostname !== '127.0.0.1') {
        showError('摄像头需要 HTTPS 连接。当前为 HTTP 局域网访问，请改用以下方式之一：\n'
          + '① 在 PC 浏览器访问 http://localhost:5000 使用拖拽上传\n'
          + '② 手机通过 ngrok 等工具创建 HTTPS 隧道\n'
          + '③ Android + USB 调试：adb reverse tcp:5000 tcp:5000，再访问 http://localhost:5000');
      } else {
        showError('您的浏览器不支持摄像头调用');
      }
      return;
    }

    try {
      cameraStream = await navigator.mediaDevices.getUserMedia({
        video: { facingMode: { exact: facingMode }, width: { ideal: 1920 }, height: { ideal: 1080 } },
        audio: false,
      });
    } catch {
      // 降级：不指定 exact
      try {
        cameraStream = await navigator.mediaDevices.getUserMedia({
          video: { facingMode: facingMode, width: { ideal: 1280 }, height: { ideal: 720 } },
          audio: false,
        });
      } catch (err) {
        showError('无法打开摄像头：' + (err.message || '权限被拒绝'));
        return;
      }
    }

    cameraVideo.srcObject = cameraStream;
    show(cameraOverlay);
    hide(errorBox);
  }

  function stopCamera() {
    if (cameraStream) {
      cameraStream.getTracks().forEach(t => t.stop());
      cameraStream = null;
    }
    cameraVideo.srcObject = null;
    hide(cameraOverlay);
  }

  btnCloseCamera.addEventListener('click', stopCamera);

  btnSwitchCamera.addEventListener('click', () => {
    facingMode = facingMode === 'environment' ? 'user' : 'environment';
    stopCamera();
    openCamera();
  });

  btnCapture.addEventListener('click', () => {
    const video = cameraVideo;
    const canvas = cameraCanvas;
    canvas.width = video.videoWidth || 1280;
    canvas.height = video.videoHeight || 720;
    const ctx = canvas.getContext('2d');
    ctx.drawImage(video, 0, 0, canvas.width, canvas.height);

    // 转为 Blob → File（相机拍照质量 0.92 属于原始采集，压缩在 handleFile 中统一做）
    canvas.toBlob((blob) => {
      if (!blob) {
        showError('拍照失败，请重试');
        return;
      }
      const file = new File([blob], 'camera_photo.jpg', { type: 'image/jpeg' });
      stopCamera();
      handleFile(file);
    }, 'image/jpeg', 0.92);
  });

  // ── 键盘关闭摄像头 ────────────────────────────────────
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && !cameraOverlay.classList.contains('hidden')) {
      stopCamera();
    }
  });

})();
