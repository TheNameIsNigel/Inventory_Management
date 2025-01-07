let isScanning = false;

function displayError(message) {
    const errorDiv = document.getElementById('error-message');
    errorDiv.textContent = message;
    errorDiv.style.display = 'block';
}

function clearError() {
    const errorDiv = document.getElementById('error-message');
    errorDiv.style.display = 'none';
}

function initializeScanner() {
    if (!navigator.mediaDevices) {
        displayError("MediaDevices API not supported in this browser.");
        return;
    }

    navigator.mediaDevices.enumerateDevices()
        .then(devices => {
            const videoDevices = devices.filter(device => device.kind === 'videoinput');
            if (videoDevices.length === 0) {
                console.warn("No video devices found. Trying getUserMedia directly.");
                return navigator.mediaDevices.getUserMedia({ video: { facingMode: "environment" } });
            }
            const selectedDeviceId = videoDevices[0].deviceId;
            startScanner(selectedDeviceId);
        })
        .catch(err => {
            console.warn("Device enumeration failed. Trying getUserMedia directly.", err);
            navigator.mediaDevices.getUserMedia({ video: { facingMode: "environment" } })
                .then(stream => {
                    const track = stream.getVideoTracks()[0];
                    const deviceId = track.getSettings().deviceId;
                    startScanner(deviceId);
                    stream.getTracks().forEach(track => track.stop());
                })
                .catch(fallbackError => {
                    displayError(`Error accessing media devices: ${fallbackError}`);
                    showManualInputOption();
                });
        });
}

function startScanner(deviceId) {
    Quagga.init({
        inputStream: {
            name: "Live",
            type: "LiveStream",
            target: document.querySelector('#interactive'),
            constraints: {
                deviceId: deviceId,
                facingMode: "environment"
            },
            area: {
                top: "25%",
                right: "10%",
                left: "10%",
                bottom: "25%"
            },
            singleChannel: false
        },
        decoder: {
            readers: [
                "code_128_reader",
                "ean_reader",
                "upc_reader"
            ],
            debug: {
                showCanvas: true,
                showPatches: true,
                showFoundPatches: true,
                showSkeleton: true,
                showLabels: true,
                showPatchLabels: true,
                showRemainingPatchLabels: true,
                boxFromPatches: {
                    showTransformed: true,
                    showTransformedBox: true,
                    showBB: true
                }
            }
        },
        locate: true
    }, function (err) {
        if (err) {
            console.error("Quagga initialization failed:", err);
            displayError(`Failed to start scanner: ${err}`);
            return;
        }
        Quagga.start();
        isScanning = true;
        clearError();
    });

    Quagga.onDetected(handleDetection);
}

function handleDetection(result) {
    const code = result.codeResult.code;
    const scanType = getScanType(result.codeResult.format);

    if (scanType === 'UPC') {
        document.getElementById('scan-sku').value = code;
    } else if (scanType === 'IMEI') {
        // This assumes some mechanism or subsequent detection for IMEI
        document.getElementById('scan-imei').value = code;
    }

    navigator.vibrate(200);
    document.body.style.backgroundColor = 'lightgreen';
    setTimeout(() => document.body.style.backgroundColor = '', 100);

    Quagga.stop();
    isScanning = false;

    const formData = new FormData(document.getElementById('scan-form'));
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
            console.error('Scan failed:', data.message);
        }
    })
    .catch(error => {
        console.error('Error submitting scan:', error);
    });
}

function getScanType(format) {
    switch (format) {
        case 'ean_13':
        case 'upc_a':
            return 'UPC';
        case 'code_128':
            return 'Barcode';
        default:
            return null;
    }
}

function showManualInputOption() {
    // Implement alternative input if necessary
}

window.addEventListener('load', initializeScanner);