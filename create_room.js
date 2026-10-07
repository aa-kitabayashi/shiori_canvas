// LINE WORKS に Bot 入りのトークルームを作成して channel_id を表示する(1回だけ使うセットアップ用)
// 使い方:
//   node create_room.js メンバーID1 メンバーID2 ...
//   例) node create_room.js taro@kuriyamatruck1966 hanako@kuriyamatruck1966
// 作成されたルームの channelId が表示されるので、config.ini の channel_id に貼り付ける
const fs = require('fs-extra');
const path = require('path');
const ini = require('ini');
const { getAccessToken, API_BASE } = require('./lineworks');

const ROOM_TITLE = 'AI自動登録通知';

const config = ini.parse(fs.readFileSync(path.join(__dirname, 'config.ini'), 'utf-8'));
const cfg = config.lineworks;

const members = process.argv.slice(2);
if (members.length === 0) {
	console.log('使い方: node create_room.js メンバーID1 メンバーID2 ...');
	console.log('例)     node create_room.js taro@kuriyamatruck1966');
	process.exit(1);
}

(async () => {
	const token = await getAccessToken(cfg);
	const res = await fetch(`${API_BASE}/bots/${cfg.bot_id}/channels`, {
		method: 'POST',
		headers: {
			'Authorization': `Bearer ${token}`,
			'Content-Type': 'application/json',
		},
		body: JSON.stringify({ members: members, title: ROOM_TITLE }),
	});
	if (!res.ok) {
		throw new Error(`ルーム作成失敗: HTTP ${res.status} ${await res.text()}`);
	}
	const json = await res.json();
	console.log(`ルーム「${ROOM_TITLE}」を作成しました`);
	console.log('');
	console.log(`channel_id = ${json.channelId}`);
	console.log('');
	console.log('↑ この値を config.ini の [lineworks] channel_id に貼り付けてください');
})().catch((err) => {
	console.error('エラー:', err.message);
	process.exit(1);
});
