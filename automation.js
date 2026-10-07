const fs = require('fs-extra');
const path = require('path');
const util = require('util');
const { chromium } = require('playwright');
const ini = require('ini');
const { sendLineWorksMessage } = require('./lineworks');

//
// 設定ファイル(config.ini)を読み込む
//
const CONFIG_PATH = path.join(__dirname, 'config.ini');
if (!fs.existsSync(CONFIG_PATH)) {
	console.error(`設定ファイルが見つかりません: ${CONFIG_PATH}`);
	console.error('config.ini.example をコピーして config.ini を作成してください。');
	process.exit(1);
}
const config = ini.parse(fs.readFileSync(CONFIG_PATH, 'utf-8'));

// 監視フォルダ(config.ini の [watch] input_dir。未設定なら automation フォルダ内の input)
const WATCH_DIR = (config.watch && config.watch.input_dir) || (__dirname + "/input");

// 処理済み移動先(config.ini の [watch] processed_dir。未設定なら automation フォルダ内の processed)
const PROCESSED_DIR = (config.watch && config.watch.processed_dir) || (__dirname + "/processed");

// エラー移動先(config.ini の [watch] error_dir。未設定なら automation フォルダ内の error)
const ERROR_DIR = (config.watch && config.watch.error_dir) || (__dirname + "/error");

// 実行時刻(config.ini の [schedule] run_time。未設定なら 02:00)
const RUN_TIME = (config.schedule && config.schedule.run_time) || '02:00';

// ログ出力先
const LOG_DIR = __dirname + "/logs";


//
// ログ: console.log / console.error を logs/log_日付時間.log にも書き出す
// エラーは加えて logs/error_日付時間.log にも書く(エラーファイルが存在する=何か起きた回)
// (ファイル名は起動時とバッチ開始のたびに切り替わる)
//
fs.ensureDirSync(LOG_DIR);

function fileStamp() {
	const d = new Date();
	const p = (n) => String(n).padStart(2, '0');
	return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}_${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
}

function timeStamp() {
	const d = new Date();
	const p = (n) => String(n).padStart(2, '0');
	return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
}

let LOG_FILE;
let ERROR_LOG_FILE;

// バッチ実行1回ごとに新しいログファイルへ切り替える(通常/エラーは同じ日時で対になる)
function newLogFile() {
	const stamp = fileStamp();
	LOG_FILE = path.join(LOG_DIR, `log_${stamp}.log`);
	ERROR_LOG_FILE = path.join(LOG_DIR, `error_${stamp}.log`);
}
newLogFile();

const origLog = console.log.bind(console);
const origError = console.error.bind(console);

function appendLog(level, args) {
	try {
		const msg = util.format(...args);
		const line = `[${timeStamp()}] [${level}] ${msg}\n`;
		fs.appendFileSync(LOG_FILE, line); // 通常ログには全て残す(時系列を追えるように)
		if (level === 'ERROR') {
			fs.appendFileSync(ERROR_LOG_FILE, line); // エラーはエラーログにも書く
		}
	} catch (e) {
		// ログ書き込み失敗で処理を止めない
	}
}

console.log = (...args) => { origLog(...args); appendLog('INFO', args); };
console.error = (...args) => { origError(...args); appendLog('ERROR', args); };


//
// LINE WORKS へ通知(未設定ならスキップ / 送信失敗しても処理は止めない)
//
async function notify(text) {
	try {
		await sendLineWorksMessage(config.lineworks, text);
	} catch (err) {
		console.error('LINE WORKS 通知に失敗しました:', err.message);
	}
}


//
// input フォルダ内の全 JSON をまとめて処理する(1回分)
//
async function runBatch() {
	newLogFile(); // バッチ1回ごとにログファイルを分ける
	await fs.ensureDir(WATCH_DIR);
	const entries = await fs.readdir(WATCH_DIR);
	const files = entries
		.filter((f) => path.extname(f).toLowerCase() === '.json')
		.sort((a, b) => a.localeCompare(b, undefined, { numeric: true })) // ファイル名の昇順(古い順)
		.map((f) => path.join(WATCH_DIR, f));

	if (files.length === 0) {
		console.log('処理対象の JSON はありません');
		return;
	}

	console.log(`処理対象: ${files.length} 件`);
	const okList = [];
	const skipList = []; // { name, reason }
	const failList = []; // { name, message }
	for (const filePath of files) {
		//console.log(`検知: ${filePath}`);
		const name = path.basename(filePath);
		try {
			const result = await handleFile(filePath); // 1件ずつ順番に処理(handleFile内で処理済みへ移動)
			if (result && result.status === 'skip') {
				skipList.push({ name, reason: result.reason });
				await notify(`⚠️【自動登録】スキップ${result.stockNo ? ' ストックNo ' + result.stockNo : ''}\n${name}\n理由: ${result.reason}`);
			} else {
				okList.push(name);
				await notify(`✅【自動登録】正常完了 ストックNo ${result.stockNo} (${result.categoryLabel})\n${name}`);
			}
		} catch (err) {
			console.error(`処理失敗: ${filePath}`, err);
			failList.push({ name, message: err.message });
			// エラーになったファイルは error フォルダへ移動(次回バッチで再処理しない。再実行したい場合は input へ戻す)
			try {
				await fs.ensureDir(ERROR_DIR);
				await fs.move(filePath, path.join(ERROR_DIR, name), { overwrite: true });
			} catch (moveErr) {
				console.error(`error フォルダへの移動に失敗: ${filePath}`, moveErr.message);
			}
			const errSummary = String(err.message).split('\n')[0].slice(0, 200); // 長いスタックは1行目だけ
			await notify(`❌【自動登録】異常終了${err.stockNo ? ' ストックNo ' + err.stockNo : ' (ストックNo不明)'}\n${name}\nエラー: ${errSummary}`);
		}
	}
	console.log('バッチ処理完了');

	// まとめ通知(2件以上処理した場合のみ。1件だけなら都度通知と重複するので送らない)
	if (files.length >= 2) {
		const lines = [];
		lines.push(failList.length > 0 ? '【自動登録バッチ】全件処理完了(エラーあり)' : '【自動登録バッチ】全件処理完了');
		lines.push(`対象: ${files.length}件 / 成功: ${okList.length}件 / スキップ: ${skipList.length}件 / 失敗: ${failList.length}件`);
		await notify(lines.join('\n'));
	}
}


//
// 次回 run_time までのミリ秒を計算
//
function msUntilNext(timeStr) {
	const [h, m] = timeStr.split(':').map(Number);
	const now = new Date();
	const next = new Date(now.getFullYear(), now.getMonth(), now.getDate(), h, m, 0, 0);
	if (next <= now) next.setDate(next.getDate() + 1); // 今日の時刻を過ぎていれば翌日
	return next - now;
}


//
// 毎日 run_time に1回だけ runBatch を実行し続ける(プロセス常駐)
//
async function scheduleLoop() {
	while (true) {
		const wait = msUntilNext(RUN_TIME);
		const next = new Date(Date.now() + wait);
		console.log(`次回実行予定: ${next.toLocaleString()} (約 ${Math.round(wait / 60000)} 分後)`);
		await new Promise((resolve) => setTimeout(resolve, wait));

		console.log(`=== バッチ開始: ${new Date().toLocaleString()} ===`);
		try {
			await runBatch();
		} catch (err) {
			console.error('バッチ処理でエラーが発生しました:', err);
			await notify(`【自動登録バッチ】異常終了\n${err.message}`);
		}
	}
}


//
// デバッグ用: input フォルダを監視し、JSON が置かれたら即 runBatch を実行する(プロセス常駐)
//
async function watchLoop() {
	await fs.ensureDir(WATCH_DIR);

	// 実行中の多重起動を防ぐ(処理中に来たイベントは終了後にもう1回だけ実行)
	let running = false;
	let pending = false;
	const trigger = async () => {
		if (running) {
			pending = true;
			return;
		}
		running = true;
		try {
			do {
				pending = false;
				try {
					await runBatch();
				} catch (err) {
					console.error('バッチ処理でエラーが発生しました:', err);
					await notify(`【自動登録バッチ】異常終了\n${err.message}`);
				}
			} while (pending);
		} finally {
			running = false;
		}
	};

	// 起動時点で残っているファイルを先に処理
	await trigger();

	// ファイル検知(書き込み完了を待つため1秒デバウンス)
	let timer = null;
	fs.watch(WATCH_DIR, (eventType, filename) => {
		if (!filename || path.extname(filename).toLowerCase() !== '.json') return;
		clearTimeout(timer);
		timer = setTimeout(() => {
			console.log(`検知: ${filename} (${new Date().toLocaleString()})`);
			trigger();
		}, 1000);
	});
	console.log('ファイル監視中... (Ctrl+C で終了)');
}


//
// templateName に含まれるキーワードで処理系統を判定する
// 例: "②内外装シート/スペックシート(ウイング) " → 箱系
// どれにも一致しない場合は「その他(未分類)」になる
//
const TEMPLATE_CATEGORIES = [
	{ category: 'box',        label: '箱系',                    keywords: ['ウイング', 'バン', 'トレーラー'] }, // 冷凍バン・冷凍ウイングも「バン」「ウイング」に一致
	{ category: 'flat_crane', label: '平系＿クレーン・ローダー', keywords: ['クレーン・ローダー'] },
	{ category: 'flat_body',  label: '平系＿平ボディ',           keywords: ['平ボディ'] },
	{ category: 'dump',       label: 'ダンプ',                  keywords: ['ダンプ'] },
	{ category: 'arm_roll',   label: 'アームロール',             keywords: ['アームロール'] },
	{ category: 'tractor',    label: 'トラクター',               keywords: ['トラクター'] },
	{ category: 'packer',     label: 'パッカー',                 keywords: ['パッカー'] },
	{ category: 'mixer',      label: 'ミキサー',                 keywords: ['ミキサー'] },
];

function classifyTemplate(data) {
	const templateName = (data.payload && data.payload.template && data.payload.template.templateName) || '';
	for (const c of TEMPLATE_CATEGORIES) {
		if (c.keywords.some((k) => templateName.includes(k))) {
			return { category: c.category, categoryLabel: c.label, templateName };
		}
	}
	return { category: 'unknown', categoryLabel: 'その他(未分類)', templateName };
}

// 系統 → 入力処理関数の対応表
// 基本的に同じ項目が多いため、現状は全系統とも fillBoxVehicle に一本化している
// (JSONに存在しない項目・画面に表示されていない項目は safe系ラッパーが自動でスキップする)
// 系統ごとに処理を変えたくなったら、専用の async function fillXxxVehicle(page, data) を作って差し替える
const FILL_HANDLERS = {
	box:        fillBoxVehicle, // 箱系
	flat_crane: fillBoxVehicle, // 平系＿クレーン・ローダー
	flat_body:  fillBoxVehicle, // 平系＿平ボディ
	dump:       fillDump, // ダンプ
	arm_roll:   fillArm, // アームロール
	tractor:    fillTractor, // トラクター
	packer:     fillPacker, // パッカー
	mixer:      fillMixer, // ミキサー
	unknown:    fillBoxVehicle, // その他(未分類)
};


//
// 処理
//
async function handleFile(filePath) {
	const data = await fs.readJson(filePath);
	//console.log('読み込んだデータ:', data);

	// ステータス確認 (payload自体が無い不正JSONもここで弾く)
	if (!data.payload || data.payload.shioriStatus != "完了") {
		console.log(`ステータス異常: ${filePath}`);
		return { status: 'skip', reason: 'ステータスが「完了」ではない' };
	}

	// テンプレート名から処理系統を判定
	const { category, categoryLabel, templateName } = classifyTemplate(data);
	console.log(`テンプレート: ${categoryLabel} [${templateName.trim() || '名称なし'}]`);

	let stockNoFull = null; // 通知用のストックNo(取得できた時点でセットされる)

	const browser = await chromium.launch({ headless: false, slowMo: 100 });
	const page = await browser.newPage();

	console.log(`処理開始: ${filePath}`);

	try {
		// ログイン
		await page.goto(config.site.base_url + "/login");
		await safeFill(page,"input[name=name]" , config.login.id);
		await safeFill(page,"input[name=pass]" , config.login.password);
		await page.click("#login_submit");

		//await page.waitForTimeout(1000);

		// サイト（書類）編集画面
		var result = getShioriValue(data, 'ストックNo.');
		if (!result) { // 項目が無い(null)場合と未入力("")の両方をスキップ
			console.log(`ストックNO無し: ${filePath}`);
			return { status: 'skip', reason: 'ストックNo.なし' };
		}
		const stock_no = String(result).split("-")[1];
		if (!stock_no) { // 「1-90149」形式でない場合もスキップ
			console.log(`ストックNO形式不正: [${result}] ${filePath}`);
			return { status: 'skip', reason: `ストックNo.形式不正 (${result})` };
		}
		stockNoFull = String(result);
		await page.goto(config.site.base_url + "/stock_regist/detail/" + stock_no);
		await page.waitForTimeout(1000);

		// 系統ごとの入力処理(未実装の系統からは false が返る)
		const filled = await FILL_HANDLERS[category](page, data);
		if (!filled) {
			console.log(`${categoryLabel}は未実装のためスキップ: ${filePath}`);
			return { status: 'skip', reason: `${categoryLabel}は未実装`, stockNo: stockNoFull };
		}

		// 登録ボタンを押す「前」にダイアログの処理を仕込む
		page.once('dialog', async (dialog) => {
			console.log('ダイアログ:', dialog.message());
			await dialog.accept();  // OK を押す
		});
		
		// 保存（更新）
		await page.click('#submit_button');
		// 登録完了待ち(直後に browser.close() すると保存リクエストが中断される恐れがあるため必須)
		await page.waitForTimeout(3000);

		console.log(`処理完了: ${filePath}`);

	} catch (err) {
		err.stockNo = stockNoFull; // 通知でどのストックNoで失敗したか分かるように
		throw err;
	} finally {
		await browser.close();
	}

	// 処理済みフォルダへ移動(同じファイル名で再検知しないように)
	await fs.ensureDir(PROCESSED_DIR);
	const destPath = path.join(PROCESSED_DIR, path.basename(filePath));
	await fs.move(filePath, destPath, { overwrite: true });

	return { status: 'ok', stockNo: stockNoFull, categoryLabel: categoryLabel };
}

// トラクター
async function fillTractor(page, data) {
	await fillBoxVehicle(page, data);

	const t_vehicle__body_manufacturer_id = getShioriValue(data, 'ヘッド-カプラーメーカー');
	await safeSelectByLabel(page, 'select[name="t_vehicle__body_manufacturer_id"]', t_vehicle__body_manufacturer_id, 'その他');

	// ヘッド-カプラ型式 (画面はボディ型式と同じ欄。要確認)
	const t_vehicle__body_model = getShioriValue(data, 'ヘッド-カプラ型式');
	await safeFill(page,'input[name="t_vehicle__body_model"]' , t_vehicle__body_model);

	return true;

}

// ダンプ
async function fillDump(page, data) {
	await fillBoxVehicle(page, data);
	
	const t_vehicle__body_manufacturer_id = getShioriValue(data, 'ダンプ-ボディーメーカー');
	await safeSelectByLabel(page, 'select[name="t_vehicle__body_manufacturer_id"]', t_vehicle__body_manufacturer_id, 'その他');
	
	const t_vehicle__body_model = getShioriValue(data, 'ダンプ-ボディー型式');
	await safeFill(page,'input[name="t_vehicle__body_model"]' , t_vehicle__body_model);
	
	var t_vehicle__koboren_cls_id = 0;
	const isKoboren_den = getShioriValue(data, 'ダンプ-コボレーン-電動');
	if (isKoboren_den) t_vehicle__koboren_cls_id = 3;
	const isKoboren_shu = getShioriValue(data, 'ダンプ-コボレーン-手動');
	if (isKoboren_shu) t_vehicle__koboren_cls_id = 2;
	const isKoboren_nasi = getShioriValue(data, 'ダンプ-コボレーン-無');
	if (isKoboren_nasi) t_vehicle__koboren_cls_id = 1;
	await safeSelectByValue(page, 'select[name="t_vehicle__koboren_cls_id"]', t_vehicle__koboren_cls_id);

	var t_vehicle__own_weight_meter_cls_id = 0;
	const isWeight_meter_ari = getShioriValue(data, 'ダンプ-自重計-有');
	if (isWeight_meter_ari) t_vehicle__own_weight_meter_cls_id = 2;
	const isWeight_meter_nai = getShioriValue(data, 'ダンプ-自重計-無');
	if (isWeight_meter_nai) t_vehicle__own_weight_meter_cls_id = 1;
	await safeSelectByValue(page, 'select[name="t_vehicle__own_weight_meter_cls_id"]', t_vehicle__own_weight_meter_cls_id);
	
	const t_vehicle__length = toHalfWidthNumber(getShioriValue(data, 'ダンプ　内寸-長さ'));
	await safeFill(page,'input[name="t_vehicle__length"]' , t_vehicle__length);

	const t_vehicle__width = toHalfWidthNumber(getShioriValue(data, 'ダンプ　幅'));
	await safeFill(page,'input[name="t_vehicle__width"]' , t_vehicle__width);

	const t_vehicle__height = toHalfWidthNumber(getShioriValue(data, 'ダンプ　高さ'));
	await safeFill(page,'input[name="t_vehicle__height"]' , t_vehicle__height);
	
	return true;
}

// アーム
async function fillArm(page, data) {
	await fillBoxVehicle(page, data);
	
	const t_vehicle__body_manufacturer_id = getShioriValue(data, 'アームロール-ボディーメーカー');
	await safeSelectByLabel(page, 'select[name="t_vehicle__body_manufacturer_id"]', t_vehicle__body_manufacturer_id, 'その他');
	
	const t_vehicle__body_model = getShioriValue(data, 'アームロール-ボディ型式');
	await safeFill(page,'input[name="t_vehicle__body_model"]' , t_vehicle__body_model);
	
	var t_vehicle__hoist_cls_id = 0;
	const isHoist_single = getShioriValue(data, 'アームロール　ホイスト-シングル');
	if (isHoist_single) t_vehicle__hoist_cls_id = 1;
	const isHoist_twin = getShioriValue(data, 'アームロール　ホイスト-ツイン');
	if (isHoist_twin) t_vehicle__hoist_cls_id = 2;
	await safeSelectByValue(page, 'select[name="t_vehicle__hoist_cls_id"]', t_vehicle__hoist_cls_id);
	

	return true;
}

// パッカー
async function fillPacker(page, data) {
	await fillBoxVehicle(page, data);
	
	const t_vehicle__body_manufacturer_id = getShioriValue(data, 'パッカー　ボディメーカー');
	await safeSelectByLabel(page, 'select[name="t_vehicle__body_manufacturer_id"]', t_vehicle__body_manufacturer_id, 'その他');
	
	const t_vehicle__body_model = getShioriValue(data, 'パッカー　ボディ型式');
	await safeFill(page,'input[name="t_vehicle__body_model"]' , t_vehicle__body_model);
	
	var t_vehicle__put_in_method_cls_id = 0;
	const isPut_press = getShioriValue(data, 'パッカー　方式-プレス');
	if (isPut_press) t_vehicle__put_in_method_cls_id = 1;
	const isPut_maki = getShioriValue(data, 'パッカー　方式-巻込');
	if (isPut_maki) t_vehicle__put_in_method_cls_id = 2;
	await safeSelectByValue(page, 'select[name="t_vehicle__put_in_method_cls_id"]', t_vehicle__put_in_method_cls_id);
	
	const t_vehicle__volume = toHalfWidthNumber(getShioriValue(data, 'パッカー　容積'));
	await safeFill(page,'input[name="t_vehicle__volume"]' , t_vehicle__volume);

	var t_vehicle__continuous_switch_cls_id = 0;
	const isSwitch_ari = getShioriValue(data, 'パッカー　連続スイッチ-有');
	if (isSwitch_ari) t_vehicle__continuous_switch_cls_id = 2;
	const isSwitch_nai = getShioriValue(data, 'パッカー　連続スイッチ-無');
	if (isSwitch_nai) t_vehicle__continuous_switch_cls_id = 1;
	await safeSelectByValue(page, 'select[name="t_vehicle__continuous_switch_cls_id"]', t_vehicle__continuous_switch_cls_id);

	return true;
}

// ミキサー
async function fillMixer(page, data) {
	await fillBoxVehicle(page, data);
	
	const t_vehicle__body_manufacturer_id = getShioriValue(data, 'ラベルミキサー-ボティーメーカー');
	await safeSelectByLabel(page, 'select[name="t_vehicle__body_manufacturer_id"]', t_vehicle__body_manufacturer_id, 'その他');
	
	const t_vehicle__body_model = getShioriValue(data, 'ミキサー-ボディー型式');
	await safeFill(page,'input[name="t_vehicle__body_model"]' , t_vehicle__body_model);
	
	return true;
}



//
// 箱系(ウイング / バン / 冷凍バン・冷凍ウイング / トレーラー)の入力処理
// 編集画面を開いた状態で呼ばれ、フォーム入力だけを行う(保存ボタンは呼び出し元が押す)
//
async function fillBoxVehicle(page, data) {

	var t_vehicle__shape_cls_id = 0;
	const isWing = getShioriValue(data, '形状ｰウイング');
	if (isWing) t_vehicle__shape_cls_id = 1;
	const isVan = getShioriValue(data, '形状ｰバン');
	if (isVan) t_vehicle__shape_cls_id = 2;
	const isTrailer = getShioriValue(data, '形状ｰトレーラー');
	if (isTrailer) t_vehicle__shape_cls_id = 12;
	const isRVan = getShioriValue(data, '形状ｰ冷凍バン');
	if (isRVan) t_vehicle__shape_cls_id = 3;
	const isRWing = getShioriValue(data, '形状ｰ冷凍ウイング');
	if (isRWing) t_vehicle__shape_cls_id = 13;
	
	
	const isHira = getShioriValue(data, '形状-平');
	if (isHira) t_vehicle__shape_cls_id = 5;
	const isCrane = getShioriValue(data, '形状-クレーン');
	if (isCrane) t_vehicle__shape_cls_id = 4;
	const isLoader = getShioriValue(data, '形状-ローダー');
	if (isLoader) t_vehicle__shape_cls_id = 4;

	const isTractor = getShioriValue(data, '形状-トラクター');
	if (isTractor) t_vehicle__shape_cls_id = 7;
	const isDump = getShioriValue(data, '形状-ダンプ');
	if (isDump) t_vehicle__shape_cls_id = 6;
	const isArm = getShioriValue(data, '形状-アームロール');
	if (isArm) t_vehicle__shape_cls_id = 9;
	const isPac = getShioriValue(data, '形状-パッカー');
	if (isPac) t_vehicle__shape_cls_id = 8;
	const isMix = getShioriValue(data, '形状-ミキサー');
	if (isMix) t_vehicle__shape_cls_id = 10;


	
	// ⑩形状 (チェックが1つも無い場合は 0 のままなので触らず、画面の選択を維持する)
	await safeSelectByValue(page, 'select[name="t_vehicle__shape_cls_id"]', t_vehicle__shape_cls_id);

	// ①走行距離
	const t_vehicle__mileage = toHalfWidthNumber(getShioriValue(data, '基本情報ｰ走行距離'));
	await safeFill(page,'input[name="t_vehicle__mileage"]' , t_vehicle__mileage);

	// ②エンジン型式
	const t_vehicle__engine_model = getShioriValue(data, '基本情報-エンジン型式');
	await safeFill(page,'input[name="t_vehicle__engine_model"]' , t_vehicle__engine_model);

	// ③馬力
	const t_vehicle__horse_power = toHalfWidthNumber(getShioriValue(data, '基本情報-馬力'));
	await safeFill(page,'input[name="t_vehicle__horse_power"]' , t_vehicle__horse_power);

	// ④シフト TODO
	//・ミッション形式　マニュアルの場合
	//　その数字+MTのもの
	//・ミッション形式　セミATの場合
	//　　メーカーがいすゞ　→　スムーサー+クラッチペダル数
	//　　メーカーが日野　→　プロシフト+クラッチペダル数
	//　　メーカーが三菱ふそう　→　イノマット+クラッチペダル数
	//　　メーカーがUD　→　エスコット++クラッチペダル数
	//・ミッション形式　オートマの場合
	//　→オートマ
	// ④ミッション-ミッション段数
	const transmission_gears = toHalfWidthNumber(getShioriValue(data, 'ミッション-ミッション段数'));

	const isTransmission_manual = getShioriValue(data, 'ミッション-ミッション方式-マニュアル');
	const isTransmission_semiAT = getShioriValue(data, 'ミッション-ミッション方式-セミAT');
	const isTransmission_automa = getShioriValue(data, 'ミッション-ミッション方式-オートマ');
	if (isTransmission_manual && transmission_gears) { // 段数が空のまま「MT」を選びに行かない
		// マニュアル
		var selected = transmission_gears + "MT";
		await safeSelectByLabel(page, 'select[name="t_vehicle__shift_cls_id"]', selected);
	}
	// オートマ
	if (isTransmission_automa) {
		await safeSelectByLabel(page, 'select[name="t_vehicle__shift_cls_id"]', 'オートマ');
	}
	// セミAT
	if (isTransmission_semiAT) {

		const t_vehicle__manufacturer_id = await page.locator(
		'select[name="t_vehicle__manufacturer_id"] option:checked'
		).textContent();
		const clutch_pedal_count = toHalfWidthNumber(getShioriValue(data, 'ミッション-クラッチペダル数'));

		var selected = "";
		if (t_vehicle__manufacturer_id == "いすず" ) {
			selected = "スムーサー(" + clutch_pedal_count + "ペダル)";
		}
		if (t_vehicle__manufacturer_id == "日野" ) {
			selected = "プロシフト(" + clutch_pedal_count + "ペダル)";
		}
		if (t_vehicle__manufacturer_id == "三菱ふそう" ) {
			selected = "イノマット(" + clutch_pedal_count + "ペダル)";
		}
		if (t_vehicle__manufacturer_id == "日産UD" ) {
			selected = "エスコット(" + clutch_pedal_count + "ペダル)";
		}
		await safeSelectByLabel(page, 'select[name="t_vehicle__shift_cls_id"]', selected);
	}

	// ⑤サスペンション
	var t_vehicle__suspension_cls_id = 0;
	const isLeaf = getShioriValue(data, '駆動他　サスペンション-リーフ');
	if (isLeaf) t_vehicle__suspension_cls_id = 1;
	const isBAir = getShioriValue(data, '駆動他　サスペンション-後輪エア');
	if (isBAir) t_vehicle__suspension_cls_id = 2;
	const isAir = getShioriValue(data, '駆動他　サスペンション-総輪エア');
	if (isAir) t_vehicle__suspension_cls_id = 3;
	const isF = getShioriValue(data, '駆動他　サスペンション-F独立');
	if (isF) t_vehicle__suspension_cls_id = 4;
	await safeSelectByValue(page, 'select[name="t_vehicle__suspension_cls_id"]', t_vehicle__suspension_cls_id);

	// ⑥ボディーメーカー (未選択なら触らない。選択肢に無いラベルは「その他」)
	const t_vehicle__body_manufacturer_id = getShioriValue(data, 'ボディ　ボディーメーカー');
	await safeSelectByLabel(page, 'select[name="t_vehicle__body_manufacturer_id"]', t_vehicle__body_manufacturer_id, 'その他');

	// ⑥ボディ型式
	const t_vehicle__body_model = getShioriValue(data, 'ボディ　ボディ型式');
	await safeFill(page,'input[name="t_vehicle__body_model"]' , t_vehicle__body_model);

	// ⑥床材
	// ⑥床
	var floor_material = 0;
	const isFloor_material_ki = getShioriValue(data, '庫内装備　床材-木');
	if (isFloor_material_ki) floor_material = 1;
	const isFloor_material_tetsu = getShioriValue(data, '庫内装備　床材-鉄');
	if (isFloor_material_tetsu) floor_material = 2;
	const isFloor_material_center = getShioriValue(data, '庫内装備　床-センターローラー');
	if (isFloor_material_center) floor_material = 3;
	const isFloor_material_aluminum = getShioriValue(data, '庫内装備　床材-アルミ');
	if (isFloor_material_aluminum) floor_material = 4;
	const isFloor_material_key = getShioriValue(data, '庫内装備　床-キーストン');
	if (isFloor_material_key) floor_material = 5;
	const isFloor_material_stainless = getShioriValue(data, '庫内装備　床材-ステン');
	if (isFloor_material_stainless) floor_material = 6;
	await safeSelectByValue(page, 'select[name="t_vehicle__floor_cls_id"]', floor_material);

	// ⑥ラッシング
	const t_vehicle__lashing = getShioriValue(data, '庫内装備　ラッシング');
	await safeFill(page,'input[name="t_vehicle__lashing"]' , t_vehicle__lashing);

	// ⑥フック
	const t_vehicle__inner_hook = toHalfWidthNumber(getShioriValue(data, '庫内装備　内フック（左右）'));
	await safeFill(page,'input[name="t_vehicle__inner_hook"]' , t_vehicle__inner_hook);
	
	// ⑥庫内装備　ロープ穴（左右）
	const t_vehicle__rope_hole = toHalfWidthNumber(getShioriValue(data, '庫内装備　ロープ穴（左右）'));
	await safeFill(page,'input[name="t_vehicle__rope_hole"]' , t_vehicle__rope_hole);
	
	// ⑥庫内装備　スタンションホール
	const t_vehicle__stanchion_hall = toHalfWidthNumber(getShioriValue(data, '庫内装備　スタンションホール'));
	await safeFill(page,'input[name="t_vehicle__stanchion_hall"]' , t_vehicle__stanchion_hall);
	
	// ⑦長さ
	const t_vehicle__length = toHalfWidthNumber(getShioriValue(data, '内寸　長さ'));
	await safeFill(page,'input[name="t_vehicle__length"]' , t_vehicle__length);

	// ⑦幅
	const t_vehicle__width = toHalfWidthNumber(getShioriValue(data, '内寸　幅'));
	await safeFill(page,'input[name="t_vehicle__width"]' , t_vehicle__width);

	// ⑦高さ
	const t_vehicle__height = toHalfWidthNumber(getShioriValue(data, '内寸　高さ'));
	await safeFill(page,'input[name="t_vehicle__height"]' , t_vehicle__height);

	// ⑦リアアオリ高さ
	const t_vehicle__rear_tilt_height = toHalfWidthNumber(getShioriValue(data, '内寸　リアアオリ高さ'));
	await safeFill(page,'input[name="t_vehicle__rear_tilt_height"]' , t_vehicle__rear_tilt_height);

	// ⑦地上高
	const t_vehicle__ground_height = toHalfWidthNumber(getShioriValue(data, '内寸　地上高'));
	await safeFill(page,'input[name="t_vehicle__ground_height"]' , t_vehicle__ground_height);

	// ⑦根太　縦ネタ
	var t_vehicle__vertical_frame_cls_id = 0;
	const t_vehicle__vertical_frame_cls_id_ki = getShioriValue(data, '根太　縦ネタ-木');
	if (t_vehicle__vertical_frame_cls_id_ki) t_vehicle__vertical_frame_cls_id = 1;
	const t_vehicle__vertical_frame_cls_id_tetsu = getShioriValue(data, '根太　縦ネタ-鉄');
	if (t_vehicle__vertical_frame_cls_id_tetsu) t_vehicle__vertical_frame_cls_id = 2;
	const t_vehicle__vertical_frame_cls_id_aluminum = getShioriValue(data, '根太　縦ネタ-アルミ');
	if (t_vehicle__vertical_frame_cls_id_aluminum) t_vehicle__vertical_frame_cls_id = 3;
	await safeSelectByValue(page, 'select[name="t_vehicle__vertical_frame_cls_id"]', t_vehicle__vertical_frame_cls_id);

	// ⑦根太　横ネタ
	var t_vehicle__horizontal_frame_cls_id = 0;
	const t_vehicle__horizontal_frame_cls_id_ki = getShioriValue(data, '根太　横ネタ-木');
	if (t_vehicle__horizontal_frame_cls_id_ki) t_vehicle__horizontal_frame_cls_id = 1;
	const t_vehicle__horizontal_frame_cls_id_tetsu = getShioriValue(data, '根太　横ネタ-鉄');
	if (t_vehicle__horizontal_frame_cls_id_tetsu) t_vehicle__horizontal_frame_cls_id = 2;
	const t_vehicle__horizontal_frame_cls_id_aluminum = getShioriValue(data, '根太　横ネタ-アルミ');
	if (t_vehicle__horizontal_frame_cls_id_aluminum) t_vehicle__horizontal_frame_cls_id = 3;
	await safeSelectByValue(page, 'select[name="t_vehicle__horizontal_frame_cls_id"]', t_vehicle__horizontal_frame_cls_id);

	// ⑦根太　横ネタ数
	const t_vehicle__horizontal_frame_number = toHalfWidthNumber(getShioriValue(data, '根太　横ネタ数'));
	await safeFill(page,'input[name="t_vehicle__horizontal_frame_number"]' , t_vehicle__horizontal_frame_number);

	// ⑦門口幅
	const t_vehicle__door_width = toHalfWidthNumber(getShioriValue(data, '門口　幅'));
	await safeFill(page,'input[name="t_vehicle__door_width"]' , t_vehicle__door_width);

	// ⑦門口高さ
	const t_vehicle__door_height = toHalfWidthNumber(getShioriValue(data, '門口　高さ'));
	await safeFill(page,'input[name="t_vehicle__door_height"]' , t_vehicle__door_height);



	// ⑧メーカー (未選択なら触らない。選択肢に無いラベルは「その他」)
	const t_vehicle__gate_manufacturer_id = getShioriValue(data, 'パワーゲート　メーカー');
	await safeSelectByLabel(page, 'select[name="t_vehicle__gate_manufacturer_id"]', t_vehicle__gate_manufacturer_id, 'その他');

	// ⑧メーカー　ゲートタイプ TODO
	// パワーゲート　ゲートタイプ-跳上
	var t_vehicle__power_gate_cls_id = 0;
	const isGate_type_lift = getShioriValue(data, 'パワーゲート　ゲートタイプ-跳上');
	const isGate_type_stow = getShioriValue(data, 'パワーゲート　ゲートタイプ-格納');
	const isGate_type_vert = getShioriValue(data, 'パワーゲート　ゲートタイプ-垂直');
	if (isGate_type_lift) t_vehicle__power_gate_cls_id = 3;
	if (isGate_type_stow) t_vehicle__power_gate_cls_id = 4;
	if (isGate_type_vert) t_vehicle__power_gate_cls_id = 5;
	await safeSelectByValue(page, 'select[name="t_vehicle__power_gate_cls_id"]', t_vehicle__power_gate_cls_id);


	// ⑧昇降能力
	const t_vehicle__gate_updown_power = getShioriValue(data, 'パワーゲート　昇降能力');
	await safeFill(page,'input[name="t_vehicle__gate_updown_power"]' , t_vehicle__gate_updown_power);

	// ⑧開閉
	var t_vehicle__open_and_close_cls_id = 0;
	const isVehicle__open_and_close_auto = getShioriValue(data, 'パワーゲート　開閉-オート');
	if (isVehicle__open_and_close_auto) t_vehicle__open_and_close_cls_id = 1;
	const isVehicle__open_and_close_balance = getShioriValue(data, 'パワーゲート　開閉-バランス');
	if (isVehicle__open_and_close_balance) t_vehicle__open_and_close_cls_id = 2;
	await safeSelectByValue(page, 'select[name="t_vehicle__open_and_close_cls_id"]', t_vehicle__open_and_close_cls_id);

	// ⑧（寸法）　奥行き
	const t_vehicle__measure_depth = toHalfWidthNumber(getShioriValue(data, '（寸法）　奥行き'));
	await safeFill(page,'input[name="t_vehicle__measure_depth"]' , t_vehicle__measure_depth);

	// ⑧（寸法）　幅
	const t_vehicle__measure_width = toHalfWidthNumber(getShioriValue(data, '（寸法）　幅'));
	await safeFill(page,'input[name="t_vehicle__measure_width"]' , t_vehicle__measure_width);

	// ⑧ストッパー
	var t_vehicle__stopper_cls_id = 0;
	const isVehicle__stopper_ari = getShioriValue(data, '（寸法）　ストッパー分割-有');
	if (isVehicle__stopper_ari) t_vehicle__stopper_cls_id = 2;
	const isVehicle__stopper_nai = getShioriValue(data, '（寸法）　ストッパー分割-無');
	if (isVehicle__stopper_nai) t_vehicle__stopper_cls_id = 1;
	await safeSelectByValue(page, 'select[name="t_vehicle__stopper_cls_id"]', t_vehicle__stopper_cls_id);

	// ⑧（寸法）　ストッパーまで奥行き
	const t_vehicle__depth_to_stopper = toHalfWidthNumber(getShioriValue(data, '（寸法）　ストッパーまで奥行き'));
	await safeFill(page,'input[name="t_vehicle__depth_to_stopper"]' , t_vehicle__depth_to_stopper);

	// ⑧（寸法）　ストッパーまで奥行き
	const t_vehicle__width_to_stopper = toHalfWidthNumber(getShioriValue(data, '（寸法）　ストッパーまで幅'));
	await safeFill(page,'input[name="t_vehicle__width_to_stopper"]' , t_vehicle__width_to_stopper);

	// ⑨冷凍機メーカー (未選択なら触らない。選択肢に無いラベルは「その他」)
	const t_vehicle__freezing_machine_manufacturer_id = getShioriValue(data, '冷凍機　冷凍機メーカー');
	await safeSelectByLabel(page, 'select[name="t_vehicle__freezing_machine_manufacturer_id"]', t_vehicle__freezing_machine_manufacturer_id, 'その他');

	// ⑨冷凍機　冷凍機型式
	const t_vehicle__freezing_machine_model = getShioriValue(data, '冷凍機　冷凍機型式');
	await safeFill(page,'input[name="t_vehicle__freezing_machine_model"]' , t_vehicle__freezing_machine_model);

	// ⑨冷凍機　スタンバイ
	var t_vehicle__freezing_machine_standby_cls_id = 0;
	const isVehicle__freezing_machine_standby_ari = getShioriValue(data, '冷凍機　スタンバイ-有');
	const isVehicle__freezing_machine_standby_nai = getShioriValue(data, '冷凍機　スタンバイ-無');
	const isVehicle__freezing_machine_code_ari = getShioriValue(data, '冷凍機　（コード）-有');
	const isVehicle__freezing_machine_code_nai = getShioriValue(data, '冷凍機　（コード）-無');
	if (isVehicle__freezing_machine_standby_nai) {
		t_vehicle__freezing_machine_standby_cls_id = 1;
	} else if (isVehicle__freezing_machine_standby_ari) {
		if (isVehicle__freezing_machine_code_ari) {
			t_vehicle__freezing_machine_standby_cls_id = 2;
		} else if (isVehicle__freezing_machine_code_nai) {
			t_vehicle__freezing_machine_standby_cls_id = 3;
		}
	}
	await safeSelectByValue(page, 'select[name="t_vehicle__freezing_machine_standby_cls_id"]', t_vehicle__freezing_machine_standby_cls_id);

	// ⑨冷凍機　温度設定-下限①
	const t_vehicle__freezing_preset_temperature = toHalfWidthNumber(getShioriValue(data, '冷凍機　温度設定-下限'));
	await safeFill(page,'input[name="t_vehicle__freezing_preset_temperature"]' , t_vehicle__freezing_preset_temperature);

	// ⑨冷凍機　温度計測-自②
	const t_vehicle__freezing_before_operate_temperature = toHalfWidthNumber(getShioriValue(data, '冷凍機　温度計測-自'));
	await safeFill(page,'input[name="t_vehicle__freezing_before_operate_temperature"]' , t_vehicle__freezing_before_operate_temperature);

	// ⑨冷凍機　温度計測-時間③
	const t_vehicle__freezing_measurement_time = toHalfWidthNumber(getShioriValue(data, '冷凍機　温度計測-時間'));
	await safeFill(page,'input[name="t_vehicle__freezing_measurement_time"]' , t_vehicle__freezing_measurement_time);

	// ⑨冷凍機　温度計測-至④
	const t_vehicle__freezing_measurement_temprature = toHalfWidthNumber(getShioriValue(data, '冷凍機　温度計測-至'));
	await safeFill(page,'input[name="t_vehicle__freezing_measurement_temprature"]' , t_vehicle__freezing_measurement_temprature);

	// ⑩クレーン-クレーンメーカー
	const t_vehicle__crane_manufacturer_id = getShioriValue(data, 'クレーン-クレーンメーカー');
	await safeSelectByLabel(page, 'select[name="t_vehicle__crane_manufacturer_id"]', t_vehicle__crane_manufacturer_id, 'その他');
	
	// ⑩クレーン-クレーン型式
	const t_vehicle__crane_model = getShioriValue(data, 'クレーン-クレーン型式');
	await safeFill(page,'input[name="t_vehicle__crane_model"]' , t_vehicle__crane_model);
	
	
	// ⑩クレーン-ラジコン
	var t_vehicle__crane_radio_control_cls_id = 0;
	const t_vehicle__crane_radio_control_cls_id_ari = getShioriValue(data, 'クレーン-ラジコン-有');
	if (t_vehicle__crane_radio_control_cls_id_ari) t_vehicle__crane_radio_control_cls_id = 2;
	const t_vehicle__crane_radio_control_cls_id_nai = getShioriValue(data, 'クレーン-ラジコン-無');
	if (t_vehicle__crane_radio_control_cls_id_nai) t_vehicle__crane_radio_control_cls_id = 1;
	await safeSelectByValue(page, 'select[name="t_vehicle__crane_radio_control_cls_id"]', t_vehicle__crane_radio_control_cls_id);
		
	// ⑩クレーン-フックイン
	var t_vehicle__hook_in_cls_id = 0;
	const t_vehicle__hook_in_cls_id_ari = getShioriValue(data, 'クレーン-フックイン-有');
	if (t_vehicle__hook_in_cls_id_ari) t_vehicle__hook_in_cls_id = 2;
	const t_vehicle__hook_in_cls_id_nai = getShioriValue(data, 'クレーン-フックイン-無');
	if (t_vehicle__hook_in_cls_id_nai) t_vehicle__hook_in_cls_id = 1;
	await safeSelectByValue(page, 'select[name="t_vehicle__hook_in_cls_id"]', t_vehicle__hook_in_cls_id);

	// ⑩クレーン-ブーム段階
	var t_vehicle__boom_stage_number_cls_id = 0;
	const t_vehicle__boom_stage_number_cls_id_3 = getShioriValue(data, 'クレーン-ブーム段階-3');
	if (t_vehicle__boom_stage_number_cls_id_3) t_vehicle__boom_stage_number_cls_id = 1;
	const t_vehicle__boom_stage_number_cls_id_4 = getShioriValue(data, 'クレーン-ブーム段階-4');
	if (t_vehicle__boom_stage_number_cls_id_4) t_vehicle__boom_stage_number_cls_id = 2;
	const t_vehicle__boom_stage_number_cls_id_5 = getShioriValue(data, 'クレーン-ブーム段階-5');
	if (t_vehicle__boom_stage_number_cls_id_5) t_vehicle__boom_stage_number_cls_id = 3;
	const t_vehicle__boom_stage_number_cls_id_6 = getShioriValue(data, 'クレーン-ブーム段階-6段');
	if (t_vehicle__boom_stage_number_cls_id_6) t_vehicle__boom_stage_number_cls_id = 4;
	await safeSelectByValue(page, 'select[name="t_vehicle__boom_stage_number_cls_id"]', t_vehicle__boom_stage_number_cls_id);
	
	// ⑩クレーン-吊トン数
	var t_vehicle__hanging_tonnage_cls_id = 0;
	const t_vehicle__hanging_tonnage_cls_id_263 = getShioriValue(data, 'クレーン-吊トン数-2.63');
	if (t_vehicle__hanging_tonnage_cls_id_263) t_vehicle__hanging_tonnage_cls_id = 1;
	const t_vehicle__hanging_tonnage_cls_id_293 = getShioriValue(data, 'クレーン-吊トン数-2.93');
	if (t_vehicle__hanging_tonnage_cls_id_293) t_vehicle__hanging_tonnage_cls_id = 2;
	await safeSelectByValue(page, 'select[name="t_vehicle__hanging_tonnage_cls_id"]', t_vehicle__hanging_tonnage_cls_id);

	// ⑩クレーン-差し違い
	var t_vehicle__insert_diff_outrigger_cls_id = 0;
	const t_vehicle__insert_diff_outrigger_cls_id_ari = getShioriValue(data, 'クレーン-差し違い-有');
	if (t_vehicle__insert_diff_outrigger_cls_id_ari) t_vehicle__insert_diff_outrigger_cls_id = 2;
	const t_vehicle__insert_diff_outrigger_cls_id_nai = getShioriValue(data, 'クレーン-差し違い-無');
	if (t_vehicle__insert_diff_outrigger_cls_id_nai) t_vehicle__insert_diff_outrigger_cls_id = 1;
	await safeSelectByValue(page, 'select[name="t_vehicle__insert_diff_outrigger_cls_id"]', t_vehicle__insert_diff_outrigger_cls_id);

	// ⑩クレーン-ハイジャッキ-有
	var t_vehicle__high_jack_cls_id = 0;
	const t_vehicle__high_jack_cls_id_ari = getShioriValue(data, 'クレーン-ハイジャッキ-有');
	if (t_vehicle__high_jack_cls_id_ari) t_vehicle__high_jack_cls_id = 2;
	const t_vehicle__high_jack_cls_id_nai = getShioriValue(data, 'クレーン-ハイジャッキ-無');
	if (t_vehicle__high_jack_cls_id_nai) t_vehicle__high_jack_cls_id = 1;
	await safeSelectByValue(page, 'select[name="t_vehicle__high_jack_cls_id"]', t_vehicle__high_jack_cls_id);
	
	// ⑩クレーン-リアアウトリガー
	var t_vehicle__rear_outrigger_cls_id = 0;
	const t_vehicle__rear_outrigger_cls_id_ari = getShioriValue(data, 'クレーン-リアアウトリガー-有');
	if (t_vehicle__rear_outrigger_cls_id_ari) t_vehicle__rear_outrigger_cls_id = 2;
	const t_vehicle__rear_outrigger_cls_id_nai = getShioriValue(data, 'クレーン-リアアウトリガー-無');
	if (t_vehicle__rear_outrigger_cls_id_nai) t_vehicle__rear_outrigger_cls_id = 1;
	await safeSelectByValue(page, 'select[name="t_vehicle__rear_outrigger_cls_id"]', t_vehicle__rear_outrigger_cls_id);



	// ⑪ホイール
	// 3項目とも JSON に存在しない(null)場合は触らず、画面の選択を維持する
	// 項目が存在してチェック無しなら「無」を選択する
	const isWheel_fe = getShioriValue(data, '駆動他　ホイール-鉄');
	const isWheel_chrome = getShioriValue(data, '駆動他　ホイール-スチールメッキ');
	const isWheel_aluminum = getShioriValue(data, '駆動他　ホイール-アルミ');
	if (isWheel_fe !== null || isWheel_chrome !== null || isWheel_aluminum !== null) {
		if (isWheel_fe || isWheel_chrome || isWheel_aluminum) {
			await safeSelectByLabel(page, 'select[name="t_vehicle__alloy_wheels_cls_id"]', '有');
		} else {
			await safeSelectByLabel(page, 'select[name="t_vehicle__alloy_wheels_cls_id"]', '無');
		}
	}
	// ⑪駆動他　燃料タンク１
	const t_vehicle__fuel_tank = toHalfWidthNumber(getShioriValue(data, '駆動他　燃料タンク１'));
	await safeFill(page,'input[name="t_vehicle__fuel_tank"]' , t_vehicle__fuel_tank);

	const t_vehicle__fuel_tank_capacity = toHalfWidthNumber(getShioriValue(data, '駆動他　燃料タンク２'));
	await safeFill(page,'input[name="t_vehicle__fuel_tank_capacity"]' , t_vehicle__fuel_tank_capacity);

	// ⑪装備　ヘッドランプ
	var t_vehicle__discharge_light_cls_id = 0;
	const isHeadlamp_halogen = getShioriValue(data, '装備　ヘッドランプ-ハロゲン');
	const isHeadlamp_hid = getShioriValue(data, '装備　ヘッドランプ-ディスチャ');
	const isHeadlamp_led = getShioriValue(data, '装備　ヘッドランプ-LED');
	if (isHeadlamp_halogen) t_vehicle__discharge_light_cls_id = 1;
	if (isHeadlamp_hid) t_vehicle__discharge_light_cls_id = 2;
	if (isHeadlamp_led) t_vehicle__discharge_light_cls_id = 3;
	await safeSelectByValue(page, 'select[name="t_vehicle__discharge_light_cls_id"]', t_vehicle__discharge_light_cls_id);
	
	// ⑪電装品　バックアイ
	var t_vehicle__back_eye_cls_id = 0;
	const isRear_view_camera_nai = getShioriValue(data, '電装品　バックアイ-無');
	const isRear_view_camera_ari = getShioriValue(data, '電装品　バックアイ-有');
	if (isRear_view_camera_nai) t_vehicle__back_eye_cls_id = 1;
	if (isRear_view_camera_ari) t_vehicle__back_eye_cls_id = 2;
	await safeSelectByValue(page, 'select[name="t_vehicle__back_eye_cls_id"]', t_vehicle__back_eye_cls_id);
	
	// ⑪電装品　ETC-有(2.0)
	var t_vehicle__etc_cls_id = 0;
	const isEtc_ari2 = getShioriValue(data, '電装品　ETC-有(2.0)');
	const isEtc_ari1 = getShioriValue(data, '電装品　ETC-有(1.0)');
	const isEtc_nai = getShioriValue(data, '電装品　ETC-無');
	if (isEtc_ari2) t_vehicle__etc_cls_id = 1;
	if (isEtc_ari1) t_vehicle__etc_cls_id = 1;
	if (isEtc_nai) t_vehicle__etc_cls_id = 2;
	await safeSelectByValue(page, 'select[name="t_vehicle__etc_cls_id"]', t_vehicle__etc_cls_id);

	// ⑩クレーン 製造年月 (しおりは西暦で入ってくる → 画面は元号プルダウン+和暦年。月はそのまま)
	const crane_manufacturing_year = toHalfWidthNumber(getShioriValue(data, 'クレーン-製造年月(年)'));
	const crane_manufacturing_month = toHalfWidthNumber(getShioriValue(data, 'クレーン-製造年月(月)'));
	const crane_wareki = seirekiToWareki(crane_manufacturing_year, crane_manufacturing_month);
	if (crane_wareki) {
		await safeSelectByValue(page, 'select[name="t_vehicle__crane_manufacturing_nengo_cls_id"]', crane_wareki.nengo_cls_id);
		await safeFill(page, 'input[name="t_vehicle__crane_manufacturing_year"]', crane_wareki.year);
	} else if (crane_manufacturing_year) {
		console.log(`クレーン製造年月(年)を西暦として変換できずスキップ: ${crane_manufacturing_year}`);
	}
	await safeFill(page, 'input[name="t_vehicle__crane_manufacturing_month"]', crane_manufacturing_month);

	return true;
}




/**
 * page.fill のラッパー。
 * - 値が空(null/undefined/false/'')なら画面に触らない(既存の入力を維持)
 * - 行が非表示などで入力できない場合もエラーにせず、ログを出して続行する
 */
async function safeFill(page, selector, value) {
	if (value === null || value === undefined || value === false || value === '') return;
	try {
		await page.fill(selector, String(value), { timeout: 2000 });
	} catch (e) {
		console.log(`入力できずスキップ: ${selector} = ${value}`);
	}
}


/**
 * プルダウンを value で選択するラッパー。
 * - 値が 0 や空(情報なし)なら画面に触らない(既存の選択を維持)
 * - 行が非表示などで選択できない場合もエラーにせず、ログを出して続行する
 */
async function safeSelectByValue(page, selector, value) {
	if (!value || String(value) === '0') return;
	try {
		await page.selectOption(selector, { value: String(value) }, { timeout: 2000 });
	} catch (e) {
		console.log(`選択できずスキップ: ${selector} = ${value}`);
	}
}


/**
 * プルダウンをラベル(表示文字)で選択するラッパー。
 * - ラベルが空(未選択)なら画面に触らない(既存の選択を維持)
 * - ラベルが選択肢に無い場合は fallbackLabel(例:「その他」)を試す
 * - それでも選択できない(行が非表示など)場合はエラーにせず、ログを出して続行する
 */
async function safeSelectByLabel(page, selector, label, fallbackLabel) {
	if (!label) return;
	try {
		await page.selectOption(selector, { label: label }, { timeout: 2000 });
	} catch (e) {
		if (!fallbackLabel) {
			console.log(`選択できずスキップ: ${selector} = ${label}`);
			return;
		}
		try {
			await page.selectOption(selector, { label: fallbackLabel }, { timeout: 2000 });
		} catch (e2) {
			console.log(`選択できずスキップ: ${selector} = ${label} / ${fallbackLabel}`);
		}
	}
}


/**
 * 項目名の表記ゆれを吸収するための正規化
 * テンプレートによって同じ項目でも区切りが違う
 * (例: 箱系「基本情報ｰ走行距離」/ クレーン「基本情報　走行距離」)
 * → スペース類とハイフン類・アンダースコアを除去して比較する
 */
function normalizeShioriName(name) {
	return String(name)
		.replace(/[\s　]/g, '')        // 半角/全角スペース
		.replace(/[-ｰ－‐_]/g, '');    // ハイフン・長音・アンダースコア類
}

/**
 * name で値を取得（該当なしは null）
 * まず完全一致で探し、無ければ正規化名の一致で探す
 * @param {Object} data Webhook JSON全体
 * @param {string} name 項目名
 * // 使用例
 * const isWing = getShioriValue(data, '形状ｰウイング');   // → false
 */
function getShioriValue(data, name) {
	const extract = (field) => {
		const v = field.values || {};
		if (field.type === 'checkbox') return v.value === true;
		if (field.type === 'pulldown1') return (v.select && v.select.label) || '';
		return v.value != null ? v.value : '';
	};

	// 1ページ目(内外装シート)は入力に使わない。同名項目が両ページにあり
	// 1ページ目が空・2ページ目に値ありのケースがあるため、複数ページなら2ページ目以降だけを見る
	const allPages = (data.payload && data.payload.pages) || [];
	const pages = allPages.length >= 2 ? allPages.slice(1) : allPages;
	const target = normalizeShioriName(name);
	let normalizedHit = null;
	for (let i = 0; i < pages.length; i++) {
		const list = pages[i].metafields || [];
		for (let j = 0; j < list.length; j++) {
			if (list[j].name === name) return extract(list[j]); // 完全一致は即返す
			if (!normalizedHit && normalizeShioriName(list[j].name) === target) {
				normalizedHit = list[j];
			}
		}
	}
	return normalizedHit ? extract(normalizedHit) : null;
}


/**
 * 文字列から数字だけを取り出す（全角数字は半角に変換）
 * 例: "３t"     → "3"
 *     "１,２００kg" → "1200"
 *     "約 50 km" → "50"
 * @param {*} value 変換元（数値・null等が来ても落ちない）
 * @returns {string} 数字のみの文字列（該当なしは ''）
 */
function toHalfWidthNumber(value) {
	if (value == null) return '';
	return String(value)
		.replace(/[０-９]/g, (c) => String.fromCharCode(c.charCodeAt(0) - 0xFEE0)) // 全角数字→半角
		.replace(/[^0-9]/g, ''); // 数字以外を除去
}


/**
 * 西暦年を画面の元号プルダウン値と和暦年に変換する
 * 画面の値: 1=平成, 2=昭和, 3=令和
 * 例: 2021 → { nengo_cls_id: 3, year: 3 } (令和3年)
 * 2019年は月が5以上(または月不明)なら令和元年、4以下なら平成31年
 * 変換できない(空・西暦4桁でない等)場合は null
 */
function seirekiToWareki(seirekiYear, month) {
	const y = parseInt(seirekiYear, 10);
	if (!y) return null;
	const m = parseInt(month, 10) || 0;
	if (y > 2019 || (y === 2019 && (m === 0 || m >= 5))) return { nengo_cls_id: 3, year: y - 2018 }; // 令和(2019/5/1〜)
	if (y >= 1989) return { nengo_cls_id: 1, year: y - 1988 }; // 平成(1989/1/8〜)
	if (y >= 1926) return { nengo_cls_id: 2, year: y - 1925 }; // 昭和(1926/12/25〜)
	return null;
}

//
// 起動
//
console.log(`監視フォルダ: ${WATCH_DIR}`);

// デバッグ用: 「node automation.js --now」で即時1回だけ実行して終了
const RUN_NOW = process.argv.includes('--now') || process.argv.includes('-n');

// デバッグ用: 「node automation.js --watch」でファイルが置かれたら即実行(常駐)
const RUN_WATCH = process.argv.includes('--watch') || process.argv.includes('-w');

if (RUN_NOW) {
	console.log('=== 即時実行モード(--now) ===');
	runBatch()
		.then(() => {
			console.log('完了して終了します');
			process.exit(0);
		})
		.catch(async (err) => {
			console.error('エラーで終了します', err);
			await notify(`【自動登録バッチ】異常終了\n${err.message}`);
			process.exit(1);
		});
} else if (RUN_WATCH) {
	console.log('=== ファイル監視モード(--watch) ===');
	watchLoop().catch((err) => {
		console.error('エラーで終了します', err);
		process.exit(1);
	});
} else {
	console.log(`毎日 ${RUN_TIME} に処理を実行します`);
	scheduleLoop();
}
