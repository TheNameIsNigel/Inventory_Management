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
            console.log("Selected device ID:", selectedDeviceId); // Log the selected device ID
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
                    console.log("Device ID from stream:", deviceId); // Log the device ID from the stream
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
                right: "25%",
                left: "25%",
                bottom: "25%"
            },
            singleChannel: false
        },
        decoder: {
            readers: [
                "code_128_reader", // For IMEI (usually Code 128 format)
                "ean_reader",      // For EAN (includes EAN-13, often used for UPCs)
                "ean_8_reader",    // For EAN-8
                "upc_reader",      // For UPC-A
                "upc_e_reader"     // For UPC-E
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
        console.log("Quagga initialization successful"); // Log successful initialization
        Quagga.start();
        isScanning = true;
        clearError();
    });

    Quagga.onDetected(handleDetection);
}

function handleDetection(result) {
    console.log("Detection result:", result); // Log the entire result object

    const code = result.codeResult.code;
    const format = result.codeResult.format;

    // Determine scan type based on format
    let scanType = getScanType(format);

    // Special handling for IMEI if it's a 15-digit number (not all IMEIs are encoded as barcodes)
    if (!scanType && code.length === 15 && /^\d+$/.test(code)) {
        scanType = 'IMEI';
    }

    if (!scanType) {
        console.warn(`Unknown scan type detected: ${format}, Code: ${code}`);
        return;
    }

    console.log("Scanned code:", code);
    console.log("Scan type:", scanType);

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
}

function getScanType(format) {
    switch (format) {
        case 'ean_13':
        case 'upc_a':
            return 'UPC';
        case 'ean_8':
            return 'EAN8';
        case 'upc_e':
            return 'UPCE';
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