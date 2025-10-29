import { chromium } from 'playwright';
import fs from 'fs';

const STATE_PATH = './note-state.json';
const SCREENSHOT_DIR = './screenshots';

// 手動ログインのため環境変数は不要

const wait = (ms) => new Promise(r => setTimeout(r, ms));

(async () => {
  let browser;
  let context;
  let page;
  let finalScreenshotPath;
  let stateSaved = false;
  let cleanupPromise;

  const ensureFinalScreenshot = async () => {
    if (!page || finalScreenshotPath) {
      return finalScreenshotPath;
    }

    await fs.promises.mkdir(SCREENSHOT_DIR, { recursive: true });
    const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
    finalScreenshotPath = `${SCREENSHOT_DIR}/final-screen-${timestamp}.png`;

    try {
      await page.screenshot({ path: finalScreenshotPath, fullPage: true });
      console.log('Saved final screenshot:', finalScreenshotPath);
    } catch (error) {
      console.error('Final screenshot capture failed:', error);
    }

    return finalScreenshotPath;
  };

  const cleanup = (exitCode = null) => {
    if (!cleanupPromise) {
      cleanupPromise = (async () => {
        await ensureFinalScreenshot();

        if (!stateSaved && context) {
          try {
            await context.storageState({ path: STATE_PATH });
            stateSaved = true;
            console.log('Saved:', STATE_PATH);
          } catch (error) {
            console.error('Failed to save storage state during cleanup:', error);
          }
        }

        if (browser) {
          try {
            await browser.close();
          } catch (error) {
            console.error('Failed to close browser during cleanup:', error);
          }
          browser = null;
        }
      })();
    }

    if (exitCode !== null) {
      cleanupPromise
        .then(() => process.exit(exitCode))
        .catch((error) => {
          console.error('Cleanup failed:', error);
          process.exit(1);
        });
    }

    return cleanupPromise;
  };

  const handleSignal = (signal) => {
    console.log(`Received ${signal}. Running cleanup before exit...`);
    cleanup(0);
  };

  process.on('SIGINT', handleSignal);
  process.on('SIGTERM', handleSignal);
  process.on('SIGHUP', handleSignal);

  process.on('uncaughtException', (error) => {
    console.error('Uncaught exception:', error);
    cleanup(1);
  });

  process.on('unhandledRejection', (reason) => {
    console.error('Unhandled rejection:', reason);
    cleanup(1);
  });

  try {
    browser = await chromium.launch({ headless: false });
    context = await browser.newContext();
    page = await context.newPage();

    await page.goto('https://note.com/login');

    console.log('手動でログインしてください。ログイン完了を自動検知します...');

    // ログイン完了を自動検知（note.comのトップページに遷移するまで待機）
    try {
      await page.waitForURL(/note\.com\/?$/, { timeout: 300000 }); // 5分待機
      console.log('ログイン完了を検知しました！');
    } catch (error) {
      console.log('ログイン完了の検知に失敗しました。手動でEnterキーを押してください。');
      await new Promise(resolve => {
        process.stdin.once('data', () => {
          resolve();
        });
      });
    }

    console.log('ログイン状態を保存中...');

    // 保存
    await context.storageState({ path: STATE_PATH });
    stateSaved = true;
    console.log('Saved:', STATE_PATH);
  } finally {
    await cleanup();
  }
})();
