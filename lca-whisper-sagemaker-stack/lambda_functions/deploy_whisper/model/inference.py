import os
import json
import sys
import subprocess
import logging
import tempfile
import time
import shutil
from io import BytesIO
import base64

# Configure logging
logging.basicConfig(level=logging.INFO)
logger = logging.getLogger(__name__)

# Set up ffmpeg using imageio-ffmpeg
def setup_ffmpeg():
    """Set up ffmpeg using imageio-ffmpeg"""
    try:
        # Use imageio-ffmpeg
        import imageio_ffmpeg
        ffmpeg_path = imageio_ffmpeg.get_ffmpeg_exe()
        logger.info(f"Using ffmpeg from imageio-ffmpeg: {ffmpeg_path}")
        
        # Set environment variable
        os.environ["FFMPEG_BINARY"] = ffmpeg_path
        
        # Add to PATH
        ffmpeg_dir = os.path.dirname(ffmpeg_path)
        os.environ["PATH"] = ffmpeg_dir + os.pathsep + os.environ.get("PATH", "")
        
        # Create a symlink to ffmpeg in a directory that's in PATH
        try:
            bin_dir = "/tmp/bin"
            os.makedirs(bin_dir, exist_ok=True)
            symlink_path = os.path.join(bin_dir, "ffmpeg")
            if not os.path.exists(symlink_path):
                os.symlink(ffmpeg_path, symlink_path)
            os.environ["PATH"] = bin_dir + os.pathsep + os.environ["PATH"]
            logger.info(f"Created symlink to ffmpeg at {symlink_path}")
        except Exception as e:
            logger.warning(f"Could not create symlink to ffmpeg: {str(e)}")
            # If symlink fails, just use the ffmpeg path directly
            logger.info("Using ffmpeg path directly without symlink")
        
        logger.info(f"Updated PATH: {os.environ['PATH']}")
    except Exception as e:
        logger.error(f"Error setting up imageio-ffmpeg: {str(e)}")
        raise RuntimeError("Failed to set up ffmpeg. Make sure imageio-ffmpeg is installed via requirements.txt")

# Install required packages
def install_requirements():
    """Install required packages for inference"""
    try:
        # Try different possible locations for requirements.txt
        req_paths = [
            os.path.join(os.path.dirname(os.path.abspath(__file__)), "requirements.txt"),
            "/opt/ml/model/requirements.txt",
            "requirements.txt"
        ]
        
        # Find requirements.txt
        req_path = None
        for path in req_paths:
            if os.path.exists(path):
                req_path = path
                logger.info(f"Found requirements.txt at {req_path}")
                break
        
        if not req_path:
            logger.warning("Could not find requirements.txt")
            return
        
        # Install packages using pip
        logger.info(f"Installing requirements from {req_path} using pip")
        subprocess.check_call([sys.executable, "-m", "pip", "install", "-r", req_path])
        logger.info("Successfully installed packages from requirements.txt")
    except Exception as e:
        logger.warning(f"Error installing requirements: {str(e)}")
        logger.info("Continuing anyway, as packages might already be installed")

# Load configuration
def load_config():
    """Load model configuration from environment variable or config file"""
    # First try to get the model from environment variable
    whisper_model = os.environ.get('WHISPER_MODEL')
    if whisper_model:
        logger.info(f"Using model from environment variable: {whisper_model}")
        return whisper_model
    
    # If not in environment, try to find a config file
    config_paths = [
        # Try current directory first (where inference.py is)
        os.path.join(os.path.dirname(os.path.abspath(__file__)), "config.py"),
        # Then try parent directory
        os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), "config.py"),
        # Then try SageMaker paths
        "/opt/ml/model/config.py"
    ]
    
    for config_path in config_paths:
        if os.path.exists(config_path):
            logger.info(f"Found config file at: {config_path}")
            try:
                # Add directory to path
                config_dir = os.path.dirname(config_path)
                if config_dir not in sys.path:
                    sys.path.insert(0, config_dir)
                
                # Try to import
                if config_dir == os.path.dirname(os.path.abspath(__file__)):
                    # Import from current directory
                    sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
                    from config import WHISPER_MODEL
                elif config_dir == os.path.dirname(os.path.dirname(os.path.abspath(__file__))):
                    # Import from parent directory
                    from config import WHISPER_MODEL
                else:
                    # Import from other location
                    import importlib.util
                    spec = importlib.util.spec_from_file_location("config_module", config_path)
                    config_module = importlib.util.module_from_spec(spec)
                    spec.loader.exec_module(config_module)
                    WHISPER_MODEL = config_module.WHISPER_MODEL
                
                logger.info(f"Using model from config file: {WHISPER_MODEL}")
                return WHISPER_MODEL
            except Exception as e:
                logger.warning(f"Error importing config from {config_path}: {str(e)}")
    
    # Default to a reasonable model if all else fails
    default_model = "base.en"
    logger.warning(f"No model configuration found. Using default model: {default_model}")
    return default_model

# Initialize environment
try:
    # Install requirements first
    install_requirements()
    
    # Setup ffmpeg
    setup_ffmpeg()
    
# Import required packages after installation
    import torch
    import boto3
    import numpy as np
    import faster_whisper
    
    # Load model configuration
    WHISPER_MODEL = load_config()
    
    # Global model cache
    _model_cache = None
    
    # Set torch thread settings for better CPU performance
    if not torch.cuda.is_available():
        # Optimize CPU threading
        torch.set_num_threads(min(4, os.cpu_count() or 1))
        torch.set_num_interop_threads(min(4, os.cpu_count() or 1))
        logger.info(f"Set torch threads to: {torch.get_num_threads()} computation, {torch.get_num_interop_threads()} interop")
    
except Exception as e:
    logger.error(f"Initialization error: {str(e)}")
    raise

def model_fn(model_dir):
    """Load the model for inference"""
    global _model_cache
    
    # Return cached model if available
    if _model_cache is not None:
        logger.info("Using cached model")
        return _model_cache
    
    # Determine device
    device = "cuda" if torch.cuda.is_available() else "cpu"
    
    # Load the faster-whisper model
    logger.info(f"Loading faster-whisper model {WHISPER_MODEL} on {device}")
    compute_type = "int8"  # Use int8 for best compatibility with older CUDA drivers
    
    try:
        model = faster_whisper.WhisperModel(WHISPER_MODEL, device=device, compute_type=compute_type)
        logger.info(f"Successfully loaded faster-whisper model {WHISPER_MODEL}")
        _model_cache = model
        return model
    except Exception as e:
        logger.error(f"Error loading faster-whisper model: {str(e)}")
        raise

def input_fn(request_body, request_content_type):
    """Parse input data"""
    if request_content_type != "application/json":
        raise ValueError("Content type must be application/json")
    
    return json.loads(request_body)

def process_audio(audio_bytes, parameters, model):
    """Process audio data using faster-whisper for faster inference"""
    # Extract parameters with defaults
    language = parameters.get('language', None)
    task = parameters.get('task', 'transcribe')
    temperature = parameters.get('temperature', 0.0)
    include_segments = parameters.get('include_segments', True)
    
    # Save to temporary file
    with tempfile.NamedTemporaryFile(delete=False, suffix='.wav') as temp_file:
        temp_file.write(audio_bytes)
        audio_path = temp_file.name
    
    try:
        logger.info(f"Running faster-whisper transcription")
        start_time = time.time()
        
        # Transcribe with faster-whisper
        segments, info = model.transcribe(
            audio_path,
            beam_size=5,
            language=language,
            task=task,
            temperature=temperature,
            vad_filter=True,
            initial_prompt=parameters.get('initial_prompt', None),
        )
        
        # Convert segments to list for JSON serialization
        segments_list = []
        for segment in segments:
            segments_list.append({
                "id": segment.id,
                "seek": 0,
                "start": segment.start,
                "end": segment.end,
                "text": segment.text,
                "tokens": segment.tokens,
                "temperature": segment.temperature,
                "avg_logprob": segment.avg_logprob,
                "compression_ratio": segment.compression_ratio,
                "no_speech_prob": segment.no_speech_prob
            })
        
        logger.info(f"faster-whisper processing completed in {time.time() - start_time:.2f} seconds")
        
        # Format result
        formatted_result = {
            'text': " ".join([segment["text"] for segment in segments_list]),
            'language': info.language
        }
        
        # Include segments if requested
        if include_segments:
            formatted_result['segments'] = segments_list
        
        return formatted_result
    
    finally:
        # Clean up temporary file
        try:
            os.unlink(audio_path)
        except Exception:
            pass
        
        # Only clear CUDA cache if explicitly requested to avoid overhead
        if torch.cuda.is_available() and parameters.get('clear_cuda_cache', False):
            torch.cuda.empty_cache()

def predict_fn(input_data, model):
    """Make prediction based on input data"""
    try:
        # Log device information
        device = "cuda" if torch.cuda.is_available() else "cpu"
        logger.info(f"Starting inference on device: {device}")
        
        start_time = time.time()
        
        # Extract parameters with defaults
        parameters = input_data.get('parameters', {})
        
        logger.info(f"Received input_data keys: {list(input_data.keys())}")
        logger.info(f"Input data type: {type(input_data)}")
    
        # Process based on input type
        if 'audio_input' in input_data:
            # Handle array of audio data
            if isinstance(input_data['audio_input'], list):
                audio_bytes = bytes(input_data['audio_input'])
            else:
                raise ValueError("audio_input must be an array of bytes")
            
            result = process_audio(audio_bytes, parameters, model)
            
        elif 's3_uri' in input_data:
            # Handle S3 URI
            s3_uri = input_data['s3_uri']
            logger.info(f"Processing audio from S3: {s3_uri}")
            
            # Parse S3 URI and download
            s3_path = s3_uri.replace('s3://', '')
            bucket_name = s3_path.split('/')[0]
            object_key = '/'.join(s3_path.split('/')[1:])
            
            # Use a more efficient S3 client configuration
            s3_client = boto3.client('s3', config=boto3.config.Config(
                max_pool_connections=50,
                retries={'max_attempts': 3}
            ))
            
            with tempfile.NamedTemporaryFile() as temp_file:
                s3_client.download_fileobj(bucket_name, object_key, temp_file)
                temp_file.seek(0)
                audio_bytes = temp_file.read()
            
            result = process_audio(audio_bytes, parameters, model)
            
        elif 'audio_data' in input_data:
            # Handle base64 encoded audio data
            audio_bytes = base64.b64decode(input_data['audio_data'])
            result = process_audio(audio_bytes, parameters, model)
            
        elif 'audio_path' in input_data:
            # Handle local file path (mainly for testing)
            logger.warning("Using local audio path, this may not work in SageMaker")
            with open(input_data['audio_path'], 'rb') as f:
                audio_bytes = f.read()
            
            result = process_audio(audio_bytes, parameters, model)
            
        else:
            raise ValueError("No valid audio input provided. Expected 'audio_input', 's3_uri', 'audio_data', or 'audio_path'")
        
        logger.info(f"Total processing time: {time.time() - start_time:.2f} seconds")
        return result
        
    except Exception as e:
        logger.error(f"Error during prediction: {str(e)}")
        return {"error": str(e)}

def output_fn(prediction, accept):
    """Format the output"""
    if accept != "application/json":
        raise ValueError("Accept header must be application/json")
    
    return json.dumps(prediction), accept
