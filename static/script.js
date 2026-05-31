/**
 * 双色球中奖查询 — 前端交互逻辑
 * 支持 PC 拖拽上传、移动端拍照/相册、结果展示
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

  // ── 工具函数 ──────────────────────────────────────────
  function show(el) { el.classList.remove('hidden'); }
  function hide(el) { el.classList.add('hidden'); }

  function setLoading(active) {
    active ? show(loadingEl) : hide(loadingEl);
    if (active) { hide(errorBox); hide(resultsEl); }
  }

  function showError(msg) {
    hide(loadingEl);
    hide(resultsEl);
    errorMessage.textContent = msg;
    show(errorBox);
  }

  function resetUploadUI() {
    hide(previewArea);
    show(uploadCard);
    currentFile = null;
    fileInput.value = '';
    hide(errorBox);
    hide(resultsEl);
  }

  // ── 文件选择处理 ──────────────────────────────────────
  function handleFile(file) {
    if (!file || !file.type.startsWith('image/')) {
      showError('请选择图片文件（JPG / PNG / HEIC）');
      return;
    }
    currentFile = file;
    const url = URL.createObjectURL(file);
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

  btnConfirm.addEventListener('click', async () => {
    if (!currentFile) return;
    hide(previewArea);
    hide(errorBox);
    hide(resultsEl);
    setLoading(true);

    const formData = new FormData();
    formData.append('file', currentFile);

    try {
      const resp = await fetch('/api/check', {
        method: 'POST',
        body: formData,
      });
      const data = await resp.json();

      setLoading(false);

      if (data.success && data.results) {
        renderResults(data);
        show(resultsEl);
        show(uploadCard); // 可再次上传
      } else if (data.success && !data.has_winning_numbers) {
        // 识别出号码但无法获取中奖号码
        renderPartial(data);
        show(resultsEl);
        show(uploadCard);
      } else {
        showError(data.error || '未知错误');
      }
    } catch (err) {
      setLoading(false);
      showError(`网络请求失败：${err.message}`);
    }
  });

  // ════════════════════════════════════════════════════════
  //  结果渲染
  // ════════════════════════════════════════════════════════

  function renderBalls(reds, blue, sm = false) {
    const cls = sm ? 'ball ball-red ball-sm' : 'ball ball-red';
    const redHTML = reds.map(r => `<span class="${cls}">${String(r).padStart(2, '0')}</span>`).join('');
    const blueCls = sm ? 'ball ball-blue ball-sm' : 'ball ball-blue';
    return `${redHTML} <span class="${blueCls}">${String(blue).padStart(2, '0')}</span>`;
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

    // 转为 Blob → File
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