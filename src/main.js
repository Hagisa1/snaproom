import { createClient } from '@supabase/supabase-js';
import QRCode from 'qrcode';
import { SUPABASE_URL, SUPABASE_PUBLIC_KEY, STORAGE_BUCKET } from './config.js';
import './style.css';

const $ = (selector) => document.querySelector(selector);
const accessScreen = $('#access-screen');
const accessMessage = $('#access-message');
const albumScreen = $('#album-screen');
const cameraMessage = $('#camera-message');
const inviteMessage = $('#invite-message');
const gallery = $('#gallery');
const photoCount = $('#photo-count');
const cameraStartArea = $('#camera-start-area');
const cameraLiveArea = $('#camera-live-area');
const previewArea = $('#photo-preview-area');
const video = $('#camera-video');
const previewImage = $('#photo-preview');
const fileInput = $('#photo-file-input');

const INVITE_STORAGE_KEY = 'snaproom-invite-token';
const INVITE_TOKEN_PATTERN = /^[a-f0-9]{64}$/i;

let supabase;
let currentUser;
let inviteToken;
let cameraStream;
let pendingPhoto;
let previewObjectUrl;
let photoChannel;
let galleryLoadSequence = 0;

const isConfigured =
  SUPABASE_URL.startsWith('https://') &&
  !SUPABASE_URL.includes('YOUR_') &&
  SUPABASE_PUBLIC_KEY &&
  !SUPABASE_PUBLIC_KEY.includes('YOUR_');

function showAccess(message = '') {
  albumScreen.hidden = true;
  accessScreen.hidden = false;
  accessMessage.textContent = message;
}

function showAlbum() {
  accessScreen.hidden = true;
  albumScreen.hidden = false;
}

function setCameraMessage(message, isError = false) {
  cameraMessage.textContent = message;
  cameraMessage.classList.toggle('is-error', isError);
}

function setBusy(button, busy, busyText = '処理中…') {
  if (busy) {
    button.dataset.originalText = button.textContent;
    button.textContent = busyText;
    button.disabled = true;
  } else {
    button.textContent = button.dataset.originalText || button.textContent;
    button.disabled = false;
  }
}

function readSavedInviteToken() {
  try {
    const token = sessionStorage.getItem(INVITE_STORAGE_KEY);
    return token && INVITE_TOKEN_PATTERN.test(token) ? token : null;
  } catch {
    return null;
  }
}

function saveInviteToken(token) {
  try {
    sessionStorage.setItem(INVITE_STORAGE_KEY, token);
  } catch {
    // The current page can still show its QR code if session storage is unavailable.
  }
}

function clearSavedInviteToken() {
  try {
    sessionStorage.removeItem(INVITE_STORAGE_KEY);
  } catch {
    // Ignore storage restrictions; access control is enforced by Supabase.
  }
}

function makeInviteUrl(token) {
  const url = new URL(window.location.href);
  url.search = '';
  url.hash = `invite=${encodeURIComponent(token)}`;
  return url.toString();
}

function removeInviteTokenFromAddressBar() {
  const url = new URL(window.location.href);
  const fragmentParams = new URLSearchParams(url.hash.slice(1));
  if (!url.searchParams.has('invite') && !fragmentParams.has('invite')) return;
  url.searchParams.delete('invite');
  fragmentParams.delete('invite');
  url.hash = fragmentParams.size ? fragmentParams.toString() : '';
  window.history.replaceState(window.history.state, '', url.toString());
}

function getInviteTokenFromUrl() {
  const url = new URL(window.location.href);
  const fragmentParams = new URLSearchParams(url.hash.slice(1));
  return fragmentParams.get('invite') || url.searchParams.get('invite');
}

function friendlyError(error) {
  const message = error?.message || String(error || '');
  if (/招待|invite/i.test(message)) return '招待リンクが無効か期限切れです。新しいリンクを開いてください。';
  if (/anonymous sign.?ins? (are )?disabled|anonymous provider/i.test(message)) {
    return 'Supabaseで匿名ログインを有効にしてください。設定方法はREADMEを確認してください。';
  }
  if (/Failed to fetch|NetworkError|fetch failed/i.test(message)) {
    return '通信に失敗しました。ネットワークとSupabaseの設定を確認してください。';
  }
  if (/Invalid API key|JWT/i.test(message)) return 'Supabaseの公開キーを確認してください。';
  if (/row-level security|permission denied|not allowed/i.test(message)) {
    return 'アクセスが許可されませんでした。SupabaseのSQL設定を確認してください。';
  }
  return '接続できませんでした。時間をおいてからもう一度お試しください。';
}

async function findMembership(userId) {
  const { data, error } = await supabase
    .from('album_members')
    .select('user_id')
    .eq('user_id', userId)
    .maybeSingle();
  if (error) throw error;
  return Boolean(data);
}

async function joinWithInvite(token) {
  const { error } = await supabase.rpc('join_album', { p_invite_token: token });
  if (error) throw error;
}

async function updateInviteCard() {
  const copyButton = $('#copy-invite-button');
  if (!inviteToken) {
    copyButton.disabled = true;
    inviteMessage.textContent = '招待URLを開き直すと、ここにQRコードが表示されます。';
    return;
  }

  copyButton.disabled = false;
  inviteMessage.textContent = '';
  await QRCode.toCanvas($('#qr-canvas'), makeInviteUrl(inviteToken), {
    width: 220,
    margin: 2,
    color: { dark: '#10131c', light: '#ffffff' },
    errorCorrectionLevel: 'Q',
  });
}

async function loadGallery() {
  const requestSequence = ++galleryLoadSequence;
  const { data, error } = await supabase
    .from('shared_photos')
    .select('id, storage_path, caption, created_at')
    .order('created_at', { ascending: false });
  if (error) throw error;

  const photos = data || [];
  if (photos.length) {
    const { data: signedFiles, error: signedUrlError } = await supabase.storage
      .from(STORAGE_BUCKET)
      .createSignedUrls(photos.map((photo) => photo.storage_path), 60 * 60);
    if (signedUrlError) throw signedUrlError;

    const urlsByPath = new Map(
      (signedFiles || [])
        .filter((file) => file.path && file.signedUrl && !file.error)
        .map((file) => [file.path, file.signedUrl]),
    );

    if (requestSequence !== galleryLoadSequence) return;
    renderGallery(photos.map((photo) => ({ ...photo, url: urlsByPath.get(photo.storage_path) })));
    return;
  }

  if (requestSequence === galleryLoadSequence) renderGallery([]);
}

function renderGallery(photos) {
  photoCount.textContent = String(photos.length);
  if (!photos.length) {
    gallery.innerHTML = `
      <div class="empty-gallery">
        <span class="empty-icon" aria-hidden="true">▧</span>
        <strong>まだ写真がありません</strong>
        <p>最初の1枚を投稿してみましょう。</p>
      </div>`;
    return;
  }

  gallery.replaceChildren();
  for (const photo of photos) {
    if (!photo.url) continue;

    const card = document.createElement('article');
    card.className = 'photo-card';
    const imageButton = document.createElement('button');
    imageButton.className = 'photo-image-button';
    imageButton.type = 'button';
    imageButton.setAttribute('aria-label', '写真を拡大表示');
    const image = document.createElement('img');
    image.src = photo.url;
    image.alt = photo.caption || '共有された写真';
    image.loading = 'lazy';
    image.decoding = 'async';
    imageButton.addEventListener('click', () => openImageViewer(photo.url, photo.caption || '', imageButton));
    imageButton.append(image);

    const details = document.createElement('div');
    details.className = 'photo-details';
    const caption = document.createElement('p');
    caption.className = 'photo-caption';
    caption.textContent = photo.caption || ' ';
    const date = document.createElement('time');
    date.className = 'photo-date';
    date.dateTime = photo.created_at;
    date.textContent = new Intl.DateTimeFormat('ja-JP', {
      month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit',
    }).format(new Date(photo.created_at));
    details.append(caption, date);
    card.append(imageButton, details);
    gallery.append(card);
  }
}

function openImageViewer(src, caption, returnFocusTo) {
  const viewer = document.createElement('div');
  viewer.className = 'image-viewer';
  viewer.setAttribute('role', 'dialog');
  viewer.setAttribute('aria-modal', 'true');
  viewer.setAttribute('aria-label', '写真を拡大表示');
  const image = document.createElement('img');
  image.src = src;
  image.alt = caption || '共有された写真';
  const close = document.createElement('button');
  close.className = 'viewer-close';
  close.type = 'button';
  close.textContent = '閉じる ✕';

  const closeViewer = () => {
    viewer.remove();
    document.removeEventListener('keydown', onKeyDown);
    returnFocusTo?.focus();
  };
  const onKeyDown = (event) => {
    if (event.key === 'Escape') closeViewer();
  };

  close.addEventListener('click', closeViewer);
  viewer.addEventListener('click', (event) => {
    if (event.target === viewer) closeViewer();
  });
  document.addEventListener('keydown', onKeyDown);
  viewer.append(close, image);
  document.body.append(viewer);
  close.focus();
}

function subscribeToPhotos() {
  return new Promise((resolve) => {
    let settled = false;
    const finish = (ready) => {
      if (settled) return;
      settled = true;
      resolve(ready);
    };

    photoChannel = supabase
      .channel('shared-album-photos')
      .on('postgres_changes', {
        event: 'INSERT', schema: 'public', table: 'shared_photos',
      }, () => {
        loadGallery().catch((error) => setCameraMessage(friendlyError(error), true));
      })
      .subscribe((status) => {
        const statusLabel = $('#realtime-status');
        const connected = status === 'SUBSCRIBED';
        statusLabel.innerHTML = `<span class="live-dot"></span>${connected ? 'リアルタイム更新中' : '再接続中'}`;
        statusLabel.classList.toggle('is-error', !connected);
        if (connected) finish(true);
        if (['CHANNEL_ERROR', 'TIMED_OUT', 'CLOSED'].includes(status)) finish(false);
      });
  });
}

async function startCamera() {
  if (!navigator.mediaDevices?.getUserMedia) {
    setCameraMessage('このブラウザではカメラを起動できません。HTTPSで開くか「写真を選ぶ」を使ってください。', true);
    return;
  }
  try {
    cameraStream = await navigator.mediaDevices.getUserMedia({
      video: { facingMode: { ideal: 'environment' }, width: { ideal: 1920 }, height: { ideal: 1080 } },
      audio: false,
    });
    video.srcObject = cameraStream;
    cameraStartArea.hidden = true;
    previewArea.hidden = true;
    cameraLiveArea.hidden = false;
    setCameraMessage('カメラを起動しました。撮影ボタンを押してください。');
  } catch (error) {
    const message = error.name === 'NotAllowedError'
      ? 'カメラの使用が許可されていません。ブラウザのサイト設定からカメラを許可してください。'
      : error.name === 'NotFoundError'
        ? '利用できるカメラが見つかりませんでした。「写真を選ぶ」をお試しください。'
        : 'カメラを起動できませんでした。写真を選ぶ方法もお試しください。';
    setCameraMessage(message, true);
  }
}

function stopCamera() {
  if (cameraStream) {
    cameraStream.getTracks().forEach((track) => track.stop());
    cameraStream = null;
  }
  video.srcObject = null;
  cameraLiveArea.hidden = true;
}

async function compressImage(blob) {
  const bitmap = await createImageBitmap(blob);
  const maxSide = 1800;
  const scale = Math.min(1, maxSide / Math.max(bitmap.width, bitmap.height));
  const canvas = document.createElement('canvas');
  canvas.width = Math.max(1, Math.round(bitmap.width * scale));
  canvas.height = Math.max(1, Math.round(bitmap.height * scale));
  const context = canvas.getContext('2d');
  context.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
  bitmap.close?.();
  return new Promise((resolve, reject) => {
    canvas.toBlob((result) => result ? resolve(result) : reject(new Error('画像を変換できませんでした。')), 'image/jpeg', 0.84);
  });
}

function clearPreview() {
  if (previewObjectUrl) {
    URL.revokeObjectURL(previewObjectUrl);
    previewObjectUrl = null;
  }
  previewImage.removeAttribute('src');
}

async function preparePhoto(blob) {
  if (!blob || !blob.type.startsWith('image/')) {
    setCameraMessage('画像ファイルを選択してください。', true);
    return;
  }
  try {
    if (blob.size > 25 * 1024 * 1024) throw new Error('元画像が25MBを超えています。別の写真を選択してください。');
    pendingPhoto = await compressImage(blob);
    clearPreview();
    previewObjectUrl = URL.createObjectURL(pendingPhoto);
    previewImage.src = previewObjectUrl;
    stopCamera();
    cameraStartArea.hidden = true;
    previewArea.hidden = false;
    setCameraMessage('写真を確認して、投稿ボタンを押してください。');
  } catch (error) {
    setCameraMessage(friendlyError(error), true);
  }
}

async function uploadPhoto(button) {
  if (!pendingPhoto || !currentUser) return;
  setBusy(button, true, '投稿中…');
  setCameraMessage('写真をアップロードしています…');
  const storagePath = `${currentUser.id}/${crypto.randomUUID()}.jpg`;
  const caption = $('#photo-caption').value.trim().slice(0, 120);
  try {
    const { error: uploadError } = await supabase.storage
      .from(STORAGE_BUCKET)
      .upload(storagePath, pendingPhoto, {
        contentType: 'image/jpeg',
        cacheControl: '3600',
        upsert: false,
      });
    if (uploadError) throw uploadError;

    const { error: insertError } = await supabase.from('shared_photos').insert({
      storage_path: storagePath,
      uploaded_by: currentUser.id,
      caption,
    });
    if (insertError) {
      const { error: cleanupError } = await supabase.storage.from(STORAGE_BUCKET).remove([storagePath]);
      if (cleanupError) throw new Error('投稿の記録に失敗し、画像の後片付けもできませんでした。管理者に連絡してください。');
      throw insertError;
    }

    pendingPhoto = null;
    clearPreview();
    $('#photo-caption').value = '';
    previewArea.hidden = true;
    cameraStartArea.hidden = false;
    setCameraMessage('投稿しました！みんなのギャラリーに反映されます。');
    await loadGallery();
  } catch (error) {
    setCameraMessage(friendlyError(error), true);
  } finally {
    setBusy(button, false);
  }
}

async function copyInviteLink() {
  if (!inviteToken) return;
  const inviteUrl = makeInviteUrl(inviteToken);
  try {
    await navigator.clipboard.writeText(inviteUrl);
    inviteMessage.textContent = '招待リンクをコピーしました。';
  } catch {
    window.prompt('この招待リンクをコピーしてください：', inviteUrl);
  }
}

function attachEvents() {
  $('#start-camera-button').addEventListener('click', startCamera);
  $('#choose-file-button').addEventListener('click', () => fileInput.click());
  fileInput.addEventListener('change', (event) => {
    const file = event.target.files?.[0];
    if (file) preparePhoto(file);
    fileInput.value = '';
  });
  $('#take-photo-button').addEventListener('click', () => {
    if (!video.videoWidth || !video.videoHeight) {
      setCameraMessage('カメラ映像を読み込み中です。少し待ってから撮影してください。', true);
      return;
    }
    const canvas = document.createElement('canvas');
    canvas.width = video.videoWidth;
    canvas.height = video.videoHeight;
    canvas.getContext('2d').drawImage(video, 0, 0, canvas.width, canvas.height);
    canvas.toBlob((blob) => {
      if (blob) preparePhoto(blob);
      else setCameraMessage('写真を準備できませんでした。もう一度撮影してください。', true);
    }, 'image/jpeg', 0.92);
  });
  $('#close-camera-button').addEventListener('click', () => {
    stopCamera();
    cameraStartArea.hidden = false;
    setCameraMessage('カメラを閉じました。');
  });
  $('#retake-button').addEventListener('click', () => {
    pendingPhoto = null;
    clearPreview();
    $('#photo-caption').value = '';
    previewArea.hidden = true;
    cameraStartArea.hidden = false;
    setCameraMessage('もう一度撮影できます。');
  });
  $('#upload-photo-button').addEventListener('click', (event) => uploadPhoto(event.currentTarget));
  $('#copy-invite-button').addEventListener('click', copyInviteLink);
  window.addEventListener('pagehide', () => {
    stopCamera();
    if (photoChannel) supabase.removeChannel(photoChannel);
    clearPreview();
  });
}

async function initialize() {
  attachEvents();
  if (!isConfigured) {
    showAccess('SupabaseのURLと公開キーをsrc/config.jsに設定してください。');
    return;
  }

  const urlToken = getInviteTokenFromUrl();
  removeInviteTokenFromAddressBar();
  const validQueryToken = urlToken && INVITE_TOKEN_PATTERN.test(urlToken) ? urlToken : null;
  const savedToken = readSavedInviteToken();
  inviteToken = validQueryToken || savedToken;
  supabase = createClient(SUPABASE_URL, SUPABASE_PUBLIC_KEY, {
    auth: { persistSession: true, autoRefreshToken: true, detectSessionInUrl: false },
  });

  try {
    const { data: sessionData, error: sessionError } = await supabase.auth.getSession();
    if (sessionError) throw sessionError;
    let session = sessionData.session;

    if (!session && !inviteToken) {
      showAccess(urlToken ? '招待リンクの形式が正しくありません。' : '招待URLを開いてください。');
      return;
    }

    if (!session) {
      const { data, error } = await supabase.auth.signInAnonymously();
      if (error) throw error;
      session = data.session;
    }
    if (!session?.user) throw new Error('Supabaseから参加者情報を取得できませんでした。');
    currentUser = session.user;

    let isMember = await findMembership(currentUser.id);
    if (inviteToken) {
      try {
        await joinWithInvite(inviteToken);
        isMember = true;
        saveInviteToken(inviteToken);
      } catch (inviteError) {
        if (!isMember) throw inviteError;
        if (inviteToken === savedToken) clearSavedInviteToken();
        inviteToken = null;
      }
    }

    if (!isMember) {
      showAccess('招待URLから参加してください。');
      return;
    }

    showAlbum();
    await updateInviteCard();
    await subscribeToPhotos();
    await loadGallery();
  } catch (error) {
    showAccess(friendlyError(error));
  }
}

initialize();
