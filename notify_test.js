// LINE WORKS 通知のテスト送信
// 使い方: config.ini の [lineworks] を記入してから  node notify_test.js
const fs = require('fs-extra');
const path = require('path');
const ini = require('ini');
const { sendLineWorksMessage } = require('./lineworks');

const config = ini.parse(fs.readFileSync(path.join(__dirname, 'config.ini'), 'utf-8'));

sendLineWorksMessage(config.lineworks, '【自動登録バッチ】テスト送信\nこのメッセージが届けば設定完了です')
	.then((sent) => {
		if (sent) {
			console.log('送信成功！LINE WORKS を確認してください');
		} else {
			console.log('config.ini の [lineworks] が未記入のため送信していません');
		}
		process.exit(0);
	})
	.catch((err) => {
		console.error('送信失敗:', err.message);
		process.exit(1);
	});
