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

    // Try to enumerate devices first
    navigator.mediaDevices.enumerateDevices()
        .then(devices => {
            const videoDevices = devices.filter(device => device.kind === 'videoinput');

            if (videoDevices.length === 0) {
                // No cameras found, try fallback
                console.warn("No video devices found. Trying getUserMedia directly.");
                return navigator.mediaDevices.getUserMedia({ video: { facingMode: "environment" } });
            }

            const selectedDeviceId = videoDevices[0].deviceId;
            startScanner(selectedDeviceId);
        })
        .catch(err => {
            // Fallback to getUserMedia if enumeration fails
            console.warn("Device enumeration failed. Trying getUserMedia directly.", err);
            navigator.mediaDevices.getUserMedia({ video: { facingMode: "environment" } })
                .then(stream => {
                    // If successful, get device ID from stream tracks
                    const track = stream.getVideoTracks()[0];
                    const deviceId = track.getSettings().deviceId;
                    startScanner(deviceId);

                    // Stop the stream tracks to release the camera
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
                "ean_8_reader",
                "code_39_reader",
                "code_39_vin_reader",
                "codabar_reader",
                "upc_reader",
                "upc_e_reader",
                "i2of5_reader",
                "2of5_reader",
                "code_93_reader"
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

    if (scanType) {
        // Set the values of the hidden form fields
        document.getElementById('scan-type').value = scanType;
        document.getElementById('scan-value').value = code;

        // Vibrate and change background color for feedback
        navigator.vibrate(200);
        document.body.style.backgroundColor = 'lightgreen';
        setTimeout(() => document.body.style.backgroundColor = '', 100);

        // Stop Quagga scanner
        Quagga.stop();
        isScanning = false;

        // Submit the form using AJAX
        const formData = new FormData(document.getElementById('scan-form'));
        fetch('/scan', {
            method: 'POST',
            body: formData
        })
        .then(response => response.json())
        .then(data => {
            if (data.success) {
                // Alert the user that they need to log in again
                alert(data.message);

                // Redirect to the home page or login page
                window.location.href = data.redirect;
            } else {
                // Handle error (e.g., display an error message)
                console.error('Scan failed:', data.message);
            }
        })
        .catch(error => {
            console.error('Error submitting scan:', error);
        });
    } else {
        console.warn(`Unknown scan type detected: ${result.codeResult.format}`);
    }
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
    // Implement logic to show an alternative input method, e.g., a text field
    // You might need to add HTML elements for this in your index.ejs
}

window.addEventListener('load', initializeScanner);