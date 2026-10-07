const fs = require('fs-extra');
const path = require('path');
const crypto = require('crypto');

//
// LINE WORKS API 2.0 で Bot からメッセージを送る
// (Service Account 認証 / JWT は Node 標準の crypto で署名するため追加パッケージ不要)
//
const TOKEN_URL = 'https://auth.worksmobile.com/oauth2/v2.0/token';
const API_BASE = 'https://www.worksapis.com/v1.0';

function base64urlFromBuffer(buf) {
	return buf.toString('base64').replace(/=+$/, '').replace(/\+/g, '-').replace(/\//g, '_');
}

function base64urlFromString(str) {
	return base64urlFromBuffer(Buffer.from(str));
}

// 必要な設定がそろっているか
function isConfigured(cfg) {
	return !!(
		cfg &&
		cfg.client_id &&
		cfg.client_secret &&
		cfg.service_account &&
		cfg.private_key_path &&
		cfg.bot_id &&
		(cfg.channel_id || cfg.user_id)
	);
}

//
// アクセストークン取得(JWT Bearer Grant)
//
async function getAccessToken(cfg) {
	const keyPath = path.isAbsolute(cfg.private_key_path)
		? cfg.private_key_path
		: path.join(__dirname, cfg.private_key_path);
	const privateKey = await fs.readFile(keyPath, 'utf-8');

	const now = Math.floor(Date.now() / 1000);
	const header = base64urlFromString(JSON.stringify({ alg: 'RS256', typ: 'JWT' }));
	const payload = base64urlFromString(JSON.stringify({
		iss: cfg.client_id,
		sub: cfg.service_account,
		iat: now,
		exp: now + 3600,
	}));
	const signature = base64urlFromBuffer(
		crypto.createSign('RSA-SHA256').update(header + '.' + payload).sign(privateKey)
	);
	const jwt = `${header}.${payload}.${signature}`;

	const res = await fetch(TOKEN_URL, {
		method: 'POST',
		headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
		body: new URLSearchParams({
			assertion: jwt,
			grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer',
			client_id: cfg.client_id,
			client_secret: cfg.client_secret,
			scope: 'bot',
		}),
	});
	if (!res.ok) {
		throw new Error(`アクセストークン取得失敗: HTTP ${res.status} ${await res.text()}`);
	}
	const json = await res.json();
	return json.access_token;
}

/**
 * LINE WORKS の Bot からテキストメッセージを送る
 * channel_id があればトークルーム宛て、無ければ user_id 宛て
 * config.ini の [lineworks] が未設定なら何もしない(false を返す)
 */
async function sendLineWorksMessage(cfg, text) {
	if (!isConfigured(cfg)) {
		console.log('LINE WORKS 未設定のため通知をスキップします');
		return false;
	}
	const token = await getAccessToken(cfg);
	const url = cfg.channel_id
		? `${API_BASE}/bots/${cfg.bot_id}/channels/${cfg.channel_id}/messages`
		: `${API_BASE}/bots/${cfg.bot_id}/users/${encodeURIComponent(cfg.user_id)}/messages`;

	const res = await fetch(url, {
		method: 'POST',
		headers: {
			'Authorization': `Bearer ${token}`,
			'Content-Type': 'application/json',
		},
		body: JSON.stringify({ content: { type: 'text', text: text } }),
	});
	if (!res.ok) {
		throw new Error(`メッセージ送信失敗: HTTP ${res.status} ${await res.text()}`);
	}
	return true;
}

module.exports = { sendLineWorksMessage, getAccessToken, API_BASE };
