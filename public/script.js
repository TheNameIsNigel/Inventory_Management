import { BrowserMultiFormatReader, NotFoundException } from '@zxing/library';

console.log('Script loaded');

document.addEventListener('DOMContentLoaded', () => {
    const codeReader = new BrowserMultiFormatReader();
    const videoElement = document.getElementById('interactive');
    const captureButton = document.getElementById('captureButton');
    let scannedData = null;

    let selectedDeviceId = null;

    function startScan() {
        console.log('Listing video devices...');
        codeReader
            .listVideoInputDevices()
            .then((videoInputDevices) => {
                console.log('Video input devices:', videoInputDevices);

                // Select the back/environment camera if available
                selectedDeviceId = videoInputDevices[0].deviceId; // Default to the first camera
                const backCamera = videoInputDevices.find(device => device.label.toLowerCase().includes('back') || device.label.toLowerCase().includes('environment'));

                if (backCamera) {
                  selectedDeviceId = backCamera.deviceId;
                }

                console.log('Starting scan with device:', selectedDeviceId);
                
                // Start scanning but do not automatically process
                startDecoding(selectedDeviceId);
            })
            .catch((err) => {
                console.error('Error listing video devices or decoding: ', err);
            });
    }

    function startDecoding(selectedDeviceId) {
        codeReader.decodeFromVideoDevice(selectedDeviceId, videoElement, (result, err) => {
            if (result) {
                console.log('Barcode detected:', result.text);
                scannedData = { code: result.text, type: null }; // Store scanned code, determine type later
            }
            if (err && !(err instanceof NotFoundException)) {
                console.error('Error scanning barcode: ', err);
            }
        });
    }

    captureButton.addEventListener('click', () => {
        if (scannedData) {
            processScannedCode(scannedData.code);
            scannedData = null; // Reset for the next scan
        } else {
            alert("No barcode detected yet.");
        }
    });

    function processScannedCode(code) {
        let type = '';
        if (code.length === 12) {
            type = 'UPC';
        } else if (code.length === 15) {
            type = 'IMEI';
        } else {
            type = 'UNKNOWN';
        }

        if (scannedData === null) {
            // First code scanned
            scannedData = { code: code, type: type };
            if (type === 'UPC') {
                alert('Please scan IMEI.');
            } else if (type === 'IMEI') {
                alert('Please scan UPC.');
            } else {
                alert('Unknown code scanned');
                scannedData = null;
            }
        } else {
            // Second code scanned
            if (type === scannedData.type) {
                // Duplicate scan
                alert('Duplicate scan detected. Please scan the other code.');
                scannedData = null; // Clear scannedData
            } else {
                // UPC and IMEI scanned
                let sku = '';
                let imei = '';

                if (type === 'UPC') {
                    sku = code;
                    imei = scannedData.code;
                } else {
                    sku = scannedData.code;
                    imei = code;
                }

                const formData = new FormData();
                formData.append('sku', sku);
                formData.append('imei', imei);

                // Log the values being appended
                console.log("Appending to FormData - SKU:", sku, "IMEI:", imei);

                // Convert formData to a plain object for logging
                let formDataObject = {};
                formData.forEach((value, key) => {
                    formDataObject[key] = value;
                });
                console.log("FormData as object:", formDataObject);

                fetch('/scan', {
                    method: 'POST',
                    body: formData
                })
                .then(response => {
                    if (!response.ok) {
                        // Log the response status and text for debugging
                        console.error('HTTP error! status:', response.status);
                        return response.text().then(text => {
                            console.error('Response text:', text);
                            throw new Error(text); // Throw error to be caught by catch block
                        });
                    }
                    return response.json();
                })
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
                        scannedData = null; // Clear scannedData
                    } else {
                        console.error('Scan failed: ', data.message);
                    }
                })
                .catch(error => {
                    console.error('Error submitting scan: ', error);
                });
            }
        }
    }

    navigator.mediaDevices
        .getUserMedia({
            video: {
                deviceId: selectedDeviceId ? { exact: selectedDeviceId } : undefined,
                facingMode: { ideal: 'environment' }
            }
        })
        .then((stream) => {
            videoElement.srcObject = stream;
            videoElement.setAttribute('playsinline', true);
            videoElement.play();
            startScan();
        })
        .catch((err) => {
            console.error('Error accessing video stream: ', err);
        });
    });