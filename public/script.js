import { BrowserMultiFormatReader, NotFoundException } from '@zxing/library';

console.log('Script loaded'); // Check if script is loaded

document.addEventListener('DOMContentLoaded', () => {
    const codeReader = new BrowserMultiFormatReader();
    const videoElement = document.getElementById('interactive');

    function startScan() {
        console.log('Listing video devices...'); // Log before listing devices
        codeReader
            .listVideoInputDevices()
            .then((videoInputDevices) => {
                console.log('Video input devices:', videoInputDevices); // Log the devices
                const selectedDeviceId = videoInputDevices[0].deviceId;

                console.log('Starting scan...'); // Log before starting scan
                codeReader.decodeFromVideoDevice(selectedDeviceId, videoElement, (result, err) => {
                    if (result) {
                        console.log('Code scanned:', result.text); // Log the scanned code
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
        const formData = new FormData();
        formData.append('sku', code);
        formData.append('imei', ''); // Update with your IMEI detection logic

        fetch('/scan', {
            method: 'POST',
            body: formData
        })
        .then(response => response.json())
        .then(data => {
            if (data.success) {
                // Dynamically add the scanned item to the table
                const tableBody = document.getElementById('scan-table-body');
                const newRow = tableBody.insertRow();
                const skuCell = newRow.insertCell();
                const imeiCell = newRow.insertCell();
                const timestampCell = newRow.insertCell();

                skuCell.textContent = code;
                imeiCell.textContent = ''; // Set the IMEI (if available)
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