import os
import time
from playwright.sync_api import sync_playwright

def run():
    os.makedirs("/home/jules/verification/screenshots", exist_ok=True)
    os.makedirs("/home/jules/verification/videos", exist_ok=True)

    with sync_playwright() as p:
        browser = p.chromium.launch(
            headless=True,
            args=["--no-sandbox", "--disable-setuid-sandbox"]
        )
        context = browser.new_context(
            record_video_dir="/home/jules/verification/videos"
        )
        page = context.new_page()

        page.add_init_script("window.__MOCK_SAVE_FILE_PICKER__ = true;")

        page.goto("http://localhost:4173")
        page.wait_for_selector("h1")

        mkv_path = os.path.abspath("sample_640x360.mkv")
        print(f"Loading {mkv_path} into file input...")
        file_input = page.locator("#file-input")
        file_input.set_input_files(mkv_path)

        page.wait_for_selector("#file-name")
        file_name = page.locator("#file-name").inner_text()
        print(f"Selected File Name: {file_name}")

        print("Clicking start conversion button...")
        page.click("#start-btn")

        for i in range(25):
            progress_text = page.locator("#progress-percent").inner_text()
            logs = page.locator("#log-console").inner_text()
            last_log = logs.strip().splitlines()[-1] if logs.strip() else 'No logs'
            print(f"Progress ({i}s): {progress_text} | Last Log: {last_log}")
            if "100%" in progress_text:
                print("Conversion reached 100%!")
                break
            time.sleep(1)

        time.sleep(2)

        screenshot_path = "/home/jules/verification/screenshots/sample_mkv_converted.png"
        page.screenshot(path=screenshot_path)
        print(f"Screenshot captured successfully at {screenshot_path}")

        context.close()
        browser.close()

if __name__ == "__main__":
    run()
