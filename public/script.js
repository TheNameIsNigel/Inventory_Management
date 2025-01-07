import { BrowserMultiFormatReader } from '@zxing/library';

document.addEventListener('DOMContentLoaded', () => {
    const codeReader = new BrowserMultiFormatReader();
    const videoElement = document.querySelector('#interactive');

    function startScan() {
        codeReader
            .decodeOnceFromVideoDevice(undefined, videoElement)
            .then((result) => {
                alert(`Code scanned: ${result.text}`);
                processScannedCode(result.text, result.resultMetadata);
                startScan();  // Restart the scanner
            })
            .catch((err) => {
                console.error('Error scanning barcode: ', err);
            });
    }

    function processScannedCode(code, metadata) {
        const formData = new FormData();
        formData.append('sku', code);  // Assuming SKU here; adapt as needed
        formData.append('imei', '');  // Empty or adjust based on your detection logic

        fetch('/scan', {
            method: 'POST',
            body: formData
        })
        .then(response => response.json())
        .then(data => {
            if (data.success) {
                alert(data.message);
                window.location.href = data.redirect;
            } else {
                console.error('Scan failed: ', data.message);
            }
        })
        .catch(error => {
            console.error('Error submitting scan: ', error);
        });
    }

    navigator.mediaDevices
        .getUserMedia({ video: { facingMode: 'environment' } })
        .then((stream) => {
            videoElement.srcObject = stream;
            videoElement.setAttribute('playsinline', true); // Required for iOS
            videoElement.play();
            startScan();
        })
        .catch((err) => console.error('Error accessing video stream: ', err));
});