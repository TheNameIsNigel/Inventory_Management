import { BrowserMultiFormatReader, NotFoundException } from '@zxing/library';

console.log('Script loaded');

document.addEventListener('DOMContentLoaded', () => {
    const codeReader = new BrowserMultiFormatReader();
    const videoElement = document.getElementById('interactive');

    function startScan() {
        console.log('Listing video devices...');
        codeReader
            .listVideoInputDevices()
            .then((videoInputDevices) => {
                console.log('Video input devices:', videoInputDevices);
                const selectedDeviceId = videoInputDevices[0].deviceId;

                console.log('Starting scan...');
                codeReader.decodeFromVideoDevice(selectedDeviceId, videoElement, (result, err) => {
                    if (result) {
                        console.log('Code scanned:', result.text);
                        processScannedCode(result.text);
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
        let type = '';
        if (code.length === 12) {
            type = 'UPC';
        } else if (code.length === 15) {
            type = 'IMEI';
        } else {
            type = 'UNKNOWN'
        }

        let sku = '';
        let imei = '';

        if (type === 'UPC') {
            sku = code;
        } else if (type === 'IMEI') {
            imei = code;
        } else {
            console.log('Unknown barcode type');
        }

        const formData = new FormData();
        formData.append('sku', sku);
        formData.append('imei', imei);

        fetch('/scan', {
            method: 'POST',
            body: formData
        })
        .then(response => response.json())
        .then(data => {
            if (data.success) {
                const tableBody = document.getElementById('scan-table-body');
                const newRow = tableBody.insertRow();
                const skuCell = newRow.insertCell();
                const imeiCell = newRow.insertCell();
                const timestampCell = newRow.insertCell();

                skuCell.textContent = sku;
                imeiCell.textContent = imei;
                timestampCell.textContent = new Date().toLocaleString();

                alert(data.message);
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
            videoElement.setAttribute('playsinline', true);
            videoElement.play();
        })
        .catch((err) => {
            console.error('Error accessing video stream: ', err);
        });

    document.getElementById('startButton').addEventListener('click', startScan);
});