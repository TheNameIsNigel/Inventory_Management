import { BrowserMultiFormatReader, NotFoundException } from '@zxing/library';

document.addEventListener('DOMContentLoaded', () => {
    const codeReader = new BrowserMultiFormatReader();
    const videoElement = document.getElementById('interactive');

    function startScan() {
        codeReader
            .listVideoInputDevices()
            .then((videoInputDevices) => {
                const selectedDeviceId = videoInputDevices[0].deviceId;
                codeReader.decodeFromVideoDevice(selectedDeviceId, videoElement, (result, err) => {
                    if (result) {
                        console.log('Code scanned:', result.text);
                        processScannedCode(result.text);
                        // Do not automatically restart the scan
                    }
                    if (err && !(err instanceof NotFoundException)) {
                        console.error('Error scanning barcode: ', err);
                    }
                });
            })
            .catch((err) => {
                console.error('Error listing video devices or decoding: ', err);
            });
    }

    function processScannedCode(code) {
        const formData = new FormData();
        formData.append('sku', code); // Assuming SKU; adjust as needed
        formData.append('imei', ''); // Adjust based on your logic

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
        })
        .catch((err) => {
            console.error('Error accessing video stream: ', err);
        });

        //Button to start the scanning process
        document.getElementById('startButton').addEventListener('click', startScan);
});